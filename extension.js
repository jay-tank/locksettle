"use strict";

/**
 * LockSettle - finds lockfiles with merge conflict markers and regenerates them the right way:
 * manifest first, then the ecosystem's own tool, in a visible VS Code task, after an explicit
 * click and a modal confirmation that shows the exact command.
 *
 * - Detection: known lockfile names found with workspace.findFiles, a file watcher, (when
 *   the built-in Git extension is available) a rescan whenever a repository's state changes,
 *   and a 15 s polling fallback that runs only while the window is focused and re-reads a
 *   file only when its mtime or size changed.
 * - Activity bar view "Conflicted lockfiles": one row per conflicted lockfile with inline
 *   Regenerate / Open manifest actions and a badge with the count.
 * - Reading lockfiles and manifests is allowed in an untrusted workspace (warnings only).
 *   git and package managers run only when vscode.workspace.isTrusted.
 * - Every path is realpath-confined to the workspace folders; symlinked lockfiles are ignored.
 * - git runs through core.runGit (execFile, args array, hardened env, hooks and fsmonitor off).
 * - No network access, no telemetry.
 */

const vscode = require("vscode");
const fs = require("fs");
const path = require("path");
const core = require("./core");

const SECTION = "locksettle";
const SOURCE = "LockSettle";
const MAX_LOCK_BYTES = 64 * 1024 * 1024;
const MAX_MANIFEST_BYTES = 8 * 1024 * 1024;
const GLOB = "**/{" + core.LOCKFILE_NAMES.join(",") + "}";
const EXCLUDE = "**/{" + core.EXCLUDED_DIRS.join(",") + "}/**";
const MANIFEST_NAMES = new Set(Object.values(core.LOCKFILES).map((l) => l.manifest));

/** @type {vscode.DiagnosticCollection} */
let diagnostics;
/** @type {vscode.StatusBarItem} */
let statusItem;
/** Map<uri string, Entry> of conflicted lockfiles. */
const conflicted = new Map();
/** Uri strings already notified during the current conflict. */
const notified = new Set();
/** Map<realpath, {mtimeMs, size, blocks}> so periodic rescans only re-read changed files. */
const readCache = new Map();
/** Realpaths looked up during the current scan; everything else is pruned from readCache. */
let touched = new Set();
/** Number of actual file reads done for detection (exposed for tests). */
let readCount = 0;
/** In-flight reads keyed by realpath + mtime + size. */
const inFlight = new Map();
const POLL_MS = 15000;
let pollTimer = null;
let disposed = false;
/** Realpaths of lockfiles with a regenerate in progress. */
const running = new Set();
const codeLensEmitter = new vscode.EventEmitter();
let scanTimer = null;
let scanning = null;
let rescanRequested = false;
const gitListeners = [];
let gitHooked = false;
/** Result of the last regenerate/stage run (exposed for tests). */
let lastResult = null;

/**
 * UI indirection so the in-editor test can answer the modal and notifications.
 * confirm(message, detail, button) -> Promise<boolean>
 * info/warn/error(message, ...buttons) -> Promise<string|undefined>
 */
const ui = {
  async confirm(message, detail, button) {
    const r = await vscode.window.showWarningMessage(message, { modal: true, detail }, button);
    return r === button;
  },
  info: (m, ...b) => vscode.window.showInformationMessage(m, ...b),
  warn: (m, ...b) => vscode.window.showWarningMessage(m, ...b),
  error: (m, ...b) => vscode.window.showErrorMessage(m, ...b),
  notifyConflict: (m, ...b) => vscode.window.showWarningMessage(m, ...b),
};

function cfg() {
  const c = vscode.workspace.getConfiguration(SECTION);
  const overrides = {};
  for (const k of core.ECOSYSTEMS.concat(["yarnBerry"])) overrides[k] = c.get("commands." + k, "");
  return {
    enabled: c.get("enabled", true),
    notify: c.get("notify", true),
    codeLens: c.get("codeLens", true),
    base: c.get("lockfileBase", {}) || {},
    yarnFlavor: c.get("yarnFlavor", "auto"),
    poetryVersion: c.get("poetryVersion", "auto"),
    overrides,
  };
}

async function realRoots() {
  const out = [];
  for (const f of vscode.workspace.workspaceFolders || []) {
    if (f.uri.scheme !== "file") continue;
    try {
      out.push(await fs.promises.realpath(f.uri.fsPath));
    } catch (_) { /* folder missing */ }
  }
  return out;
}

async function readCapped(p, max) {
  const st = await fs.promises.stat(p);
  if (!st.isFile() || st.size > max) return null;
  return fs.promises.readFile(p, "utf8");
}

/**
 * Conflict blocks of a (realpath'd) file. Unless `fresh`, the file is read only when its
 * mtime or size changed since the last read. Throws when the file cannot be stat'ed.
 */
async function conflictBlocksOf(real, max, fresh) {
  const st = await fs.promises.stat(real);
  touched.add(real);
  const c = readCache.get(real);
  if (!fresh && c && c.mtimeMs === st.mtimeMs && c.size === st.size) return c.blocks;
  // A watcher event and a scan can ask for the same changed file at once: read it only once.
  const flightKey = real + "\0" + st.mtimeMs + "\0" + st.size;
  if (!fresh && inFlight.has(flightKey)) return inFlight.get(flightKey);
  const p = (async () => {
    let blocks = [];
    if (st.isFile() && st.size <= max) {
      readCount++;
      blocks = core.findConflictBlocks(await fs.promises.readFile(real, "utf8"));
    }
    readCache.set(real, { mtimeMs: st.mtimeMs, size: st.size, blocks });
    return blocks;
  })();
  if (fresh) return p;
  inFlight.set(flightKey, p);
  try {
    return await p;
  } finally {
    inFlight.delete(flightKey);
  }
}

/**
 * Validate a lockfile uri: known name, file scheme, not a symlink, realpath inside a
 * workspace folder. Returns { real, info, folder } or { error }.
 */
async function resolveLockfile(uri) {
  if (!uri || uri.scheme !== "file") return { error: "not-lockfile" };
  const info = core.lockfileInfo(uri.fsPath);
  if (!info) return { error: "not-lockfile" };
  let lst;
  try {
    lst = await fs.promises.lstat(uri.fsPath);
  } catch (_) {
    return { error: "missing" };
  }
  if (lst.isSymbolicLink()) return { error: "symlink" };
  if (!lst.isFile()) return { error: "not-lockfile" };
  const real = await core.confine(uri.fsPath, await realRoots());
  if (!real) return { error: "outside-workspace" };
  const folder = vscode.workspace.getWorkspaceFolder(uri);
  if (!folder) return { error: "outside-workspace" };
  return { real, info, folder };
}

// ---------------------------------------------------------------------------------------
// Detection
// ---------------------------------------------------------------------------------------

async function checkFile(uri, roots) {
  const key = uri.toString();
  if (!cfg().enabled) {
    conflicted.delete(key);
    return;
  }
  const r = await resolveLockfile(uri);
  let blocks = [];
  if (!r.error) {
    try {
      blocks = await conflictBlocksOf(r.real, MAX_LOCK_BYTES, false);
    } catch (_) {
      blocks = [];
    }
  }
  if (blocks.length) {
    // Manifest state for the view: conflicted manifests block regeneration.
    let manifest = null;
    try {
      manifest = await findConflictedManifest(path.dirname(r.real), r.info, roots || (await realRoots()), false);
    } catch (_) { /* ignore */ }
    conflicted.set(key, { uri, info: r.info, blocks, real: r.real, folder: r.folder, manifest });
  } else {
    conflicted.delete(key);
    notified.delete(key);
  }
}

function render() {
  const c = cfg();
  diagnostics.clear();
  for (const [key, e] of conflicted) {
    const n = e.blocks.length;
    const d = new vscode.Diagnostic(
      new vscode.Range(0, 0, 0, 1000),
      e.info.name + " has merge conflicts (" + n + " conflict block" + (n === 1 ? "" : "s") + "). Don't edit it by hand - LockSettle can regenerate it from " + e.info.manifest + ".",
      vscode.DiagnosticSeverity.Error
    );
    d.source = SOURCE;
    d.code = "LS001";
    diagnostics.set(e.uri, [d]);
    if (c.notify && !notified.has(key)) {
      notified.add(key);
      const rel = vscode.workspace.asRelativePath(e.uri);
      Promise.resolve(ui.notifyConflict(rel + " has merge conflicts. Don't edit it by hand - LockSettle can regenerate it.", "Regenerate", "Open"))
        .then((choice) => {
          if (choice === "Regenerate") vscode.commands.executeCommand("locksettle.regenerate", e.uri);
          else if (choice === "Open") vscode.window.showTextDocument(e.uri);
        })
        .catch(() => {});
    }
  }
  const n = conflicted.size;
  if (n && c.enabled) {
    statusItem.text = "$(lock) LockSettle: " + n + " conflicted lockfile" + (n === 1 ? "" : "s");
    statusItem.tooltip = "Lockfiles with merge conflict markers. Click to regenerate one.";
    statusItem.backgroundColor = new vscode.ThemeColor("statusBarItem.warningBackground");
    statusItem.show();
  } else {
    statusItem.text = "";
    statusItem.hide();
  }
  codeLensEmitter.fire();
  refreshTree();
}

/**
 * Scan the workspace. Scans never overlap: a request that arrives while one is running makes
 * it run once more when it finishes (so callers always see a scan that started after their
 * call, and a stream of change events cannot starve the scan).
 */
function scanAll() {
  if (scanning) {
    rescanRequested = true;
    return scanning;
  }
  scanning = (async () => {
    do {
      rescanRequested = false;
      await scanOnce();
    } while (rescanRequested && !disposed);
  })().finally(() => {
    scanning = null;
  });
  return scanning;
}

async function scanOnce() {
  if (!cfg().enabled) {
    conflicted.clear();
    render();
    return;
  }
  const found = new Map();
  for (const f of vscode.workspace.workspaceFolders || []) {
    if (f.uri.scheme !== "file") continue;
    const uris = await vscode.workspace.findFiles(new vscode.RelativePattern(f, GLOB), EXCLUDE, 5000);
    for (const u of uris) found.set(u.toString(), u);
  }
  touched = new Set();
  const roots = await realRoots();
  for (const k of Array.from(conflicted.keys())) if (!found.has(k)) conflicted.delete(k);
  for (const u of found.values()) await checkFile(u, roots);
  // Forget files that no longer exist or are no longer looked at.
  for (const k of Array.from(readCache.keys())) if (!touched.has(k)) readCache.delete(k);
  render();
}

function scheduleScan(delay) {
  clearTimeout(scanTimer);
  scanTimer = setTimeout(() => scanAll().catch(() => {}), delay === undefined ? 600 : delay);
}

function hookGit() {
  if (gitHooked || !vscode.workspace.isTrusted) return;
  const ext = vscode.extensions.getExtension("vscode.git");
  if (!ext) return;
  Promise.resolve(ext.isActive ? ext.exports : ext.activate())
    .then((exp) => {
      if (!exp || typeof exp.getAPI !== "function" || gitHooked) return;
      const api = exp.getAPI(1);
      gitHooked = true;
      const watch = (repo) => gitListeners.push(repo.state.onDidChange(() => scheduleScan(800)));
      api.repositories.forEach(watch);
      gitListeners.push(api.onDidOpenRepository((repo) => {
        watch(repo);
        scheduleScan(800);
      }));
    })
    .catch(() => {});
}

// ---------------------------------------------------------------------------------------
// Activity bar view: "Conflicted lockfiles"
// ---------------------------------------------------------------------------------------

const VIEW_ID = "locksettle.lockfiles";
/** @type {vscode.TreeView<object>} */
let treeView;
const treeEmitter = new vscode.EventEmitter();

function relPath(uri) {
  return vscode.workspace.asRelativePath(uri, true);
}

function sortedEntries() {
  return Array.from(conflicted.values()).sort((a, b) => relPath(a.uri).localeCompare(relPath(b.uri)));
}

/** Row data for one conflicted lockfile (also used by the test API). */
function rowFor(e) {
  const rel = relPath(e.uri);
  const n = e.blocks.length;
  const blocked = !!e.manifest;
  const manifestRel = blocked ? relPath(vscode.Uri.file(e.manifest.path)) : path.join(path.dirname(rel), e.info.manifest).split(path.sep).join("/");
  const lines = [
    rel + ":" + (e.blocks[0].start + 1),
    e.info.name + " has merge conflicts (" + n + " conflict block" + (n === 1 ? "" : "s") + "). Don't edit it by hand - LockSettle can regenerate it from " + e.info.manifest + ".",
    "",
    blocked
      ? "Manifest " + manifestRel + ":" + (e.manifest.line + 1) + " still has conflict markers. Resolve it first, then regenerate."
      : "Manifest " + manifestRel + " is conflict-free. Ready to regenerate with base \"" + core.resolveBase(e.info.ecosystem, cfg().base) + "\".",
  ];
  return {
    label: rel,
    description: e.info.ecosystem + " - " + (blocked ? "manifest conflicted" : "ready to regenerate"),
    tooltip: lines.join("\n"),
    contextValue: blocked ? "lockfile.manifestConflicted" : "lockfile.ready",
    icon: blocked ? "error" : "warning",
    line: e.blocks[0].start,
  };
}

const lockfilesProvider = {
  onDidChangeTreeData: treeEmitter.event,
  getChildren(el) {
    if (el || !cfg().enabled) return [];
    return sortedEntries();
  },
  getTreeItem(e) {
    const row = rowFor(e);
    const item = new vscode.TreeItem(row.label, vscode.TreeItemCollapsibleState.None);
    item.id = e.uri.toString();
    item.description = row.description;
    item.tooltip = row.tooltip;
    item.contextValue = row.contextValue;
    item.iconPath = new vscode.ThemeIcon(row.icon, new vscode.ThemeColor(row.icon === "error" ? "list.errorForeground" : "list.warningForeground"));
    item.command = { command: "locksettle.openLockfile", title: "Open lockfile", arguments: [e.uri] };
    return item;
  },
};

function refreshTree() {
  treeEmitter.fire(undefined);
  if (!treeView) return;
  const n = cfg().enabled ? conflicted.size : 0;
  treeView.badge = n ? { value: n, tooltip: n + " conflicted lockfile" + (n === 1 ? "" : "s") } : undefined;
}

/** Accept only a live conflicted entry (a Uri or an object with a Uri); never trust other args. */
function liveEntry(arg) {
  const uri = arg instanceof vscode.Uri ? arg : arg && arg.uri instanceof vscode.Uri ? arg.uri : undefined;
  return uri ? conflicted.get(uri.toString()) : undefined;
}

async function openAt(uri, line) {
  const doc = await vscode.workspace.openTextDocument(uri);
  const l = Math.max(0, Math.min(line, doc.lineCount - 1));
  const pos = new vscode.Position(l, 0);
  await vscode.window.showTextDocument(doc, { selection: new vscode.Range(pos, pos), preview: true });
}

/** Open a conflicted lockfile at its first conflict block. */
async function openLockfile(arg) {
  const e = liveEntry(arg);
  if (!e) return { status: "not-conflicted" };
  const r = await resolveLockfile(e.uri);
  if (r.error) return { status: r.error };
  const line = e.blocks[0].start;
  await openAt(e.uri, line);
  return { status: "opened", path: e.uri.fsPath, line };
}

/** Open the manifest paired with a conflicted lockfile, at its conflict if it has one. */
async function openManifest(arg) {
  let e = liveEntry(arg);
  if (!e && arg === undefined) {
    const u = await pickConflicted("Pick the lockfile whose manifest to open");
    e = u ? conflicted.get(u.toString()) : undefined;
    if (!e) return { status: "cancelled" };
  }
  if (!e) return { status: "not-conflicted" };
  const target = e.manifest ? e.manifest.path : path.join(path.dirname(e.real), e.info.manifest);
  const line = e.manifest ? e.manifest.line : 0;
  let lst;
  try {
    lst = await fs.promises.lstat(target);
  } catch (_) {
    ui.warn("LockSettle: " + e.info.manifest + " was not found next to " + relPath(e.uri) + ".");
    return { status: "manifest-missing" };
  }
  if (lst.isSymbolicLink() || !lst.isFile() || !(await core.confine(target, await realRoots()))) {
    return { status: "outside-workspace" };
  }
  await openAt(vscode.Uri.file(target), line);
  return { status: "opened", path: target, line };
}

// ---------------------------------------------------------------------------------------
// Polling fallback
// ---------------------------------------------------------------------------------------

/**
 * File watchers do not fire everywhere (network file systems, exhausted inotify limits), so a
 * light rescan runs every 15 s, but only while the window is focused and LockSettle is
 * enabled. Unchanged files are not re-read (mtime/size cache). Losing focus or disposing the
 * extension stops the timer; regaining focus rescans once and restarts it.
 */
function startPolling() {
  if (pollTimer || disposed || !cfg().enabled) return;
  pollTimer = setInterval(() => {
    if (!vscode.window.state.focused || !cfg().enabled) {
      stopPolling();
      return;
    }
    scheduleScan(0);
  }, POLL_MS);
}

function stopPolling() {
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = null;
}

function onWindowFocus(focused) {
  if (disposed) return;
  if (focused) {
    startPolling();
    scheduleScan(300);
  } else {
    stopPolling();
  }
}

// ---------------------------------------------------------------------------------------
// Regenerate
// ---------------------------------------------------------------------------------------

async function pickConflicted(placeHolder) {
  const items = quickPickItems();
  if (!items.length) {
    ui.info("LockSettle: no lockfile in this workspace has merge conflict markers.");
    return undefined;
  }
  const choice = await vscode.window.showQuickPick(items, { placeHolder });
  return choice ? choice.uri : undefined;
}

function quickPickItems() {
  const c = cfg();
  return Array.from(conflicted.values()).map((e) => {
    const dir = path.dirname(vscode.workspace.asRelativePath(e.uri, true));
    return {
      label: "$(lock) " + e.info.name,
      description: dir === "." ? "" : dir,
      detail: e.blocks.length + " conflict block(s) - " + e.info.ecosystem + ", base: " + core.resolveBase(e.info.ecosystem, c.base),
      uri: e.uri,
    };
  });
}

/**
 * Find a conflicted manifest that blocks regeneration, or null. `fresh` re-reads every
 * manifest (used right before regenerating); otherwise unchanged files come from the cache.
 */
async function findConflictedManifest(lockDir, info, roots, fresh) {
  const paired = path.join(lockDir, info.manifest);
  const candidates = [paired];
  const extra = await vscode.workspace.findFiles(new vscode.RelativePattern(vscode.Uri.file(lockDir), "**/" + info.manifest), EXCLUDE, 500);
  for (const u of extra) {
    const d = path.dirname(u.fsPath);
    if (u.fsPath === paired) continue;
    // A nested folder with its own lockfile is a separate project.
    if (fs.existsSync(path.join(d, info.name))) continue;
    candidates.push(u.fsPath);
  }
  for (const p of candidates) {
    let lst;
    try {
      lst = await fs.promises.lstat(p);
    } catch (_) {
      continue;
    }
    if (lst.isSymbolicLink()) continue;
    const real = await core.confine(p, roots);
    if (!real) continue;
    let blocks;
    try {
      blocks = await conflictBlocksOf(real, MAX_MANIFEST_BYTES, fresh);
    } catch (_) {
      continue;
    }
    if (blocks.length) return { path: p, line: blocks[0].start };
  }
  return null;
}

function done(result) {
  lastResult = result;
  return result;
}

function waitForTask(execution, pending) {
  return new Promise((resolve) => {
    const check = () => {
      const hit = pending.events.find((e) => e.execution === execution);
      if (hit) {
        cleanup();
        resolve(hit.exitCode);
        return true;
      }
      return false;
    };
    let endTimer = null;
    const onEnd = vscode.tasks.onDidEndTask((e) => {
      if (e.execution !== execution) return;
      // The process end event normally arrives first; give it a moment.
      endTimer = setTimeout(() => {
        if (!check()) {
          cleanup();
          resolve(undefined);
        }
      }, 1500);
    });
    const onProc = vscode.tasks.onDidEndTaskProcess((e) => {
      pending.events.push(e);
      check();
    });
    function cleanup() {
      onEnd.dispose();
      onProc.dispose();
      pending.listener.dispose();
      clearTimeout(endTimer);
    }
    check();
  });
}

async function regenerate(arg) {
  let uri = arg instanceof vscode.Uri ? arg : arg && arg.uri instanceof vscode.Uri ? arg.uri : undefined;
  if (!uri) {
    const ed = vscode.window.activeTextEditor;
    if (ed && core.lockfileInfo(ed.document.uri.fsPath) && conflicted.has(ed.document.uri.toString())) uri = ed.document.uri;
    else uri = await pickConflicted("Pick the lockfile to regenerate");
  }
  if (!uri) return done({ status: "cancelled" });

  if (!vscode.workspace.isTrusted) {
    Promise.resolve(ui.warn("LockSettle runs git and package managers only in a trusted workspace.", "Manage Workspace Trust"))
      .then((c) => c && vscode.commands.executeCommand("workbench.trust.manage"))
      .catch(() => {});
    return done({ status: "untrusted" });
  }

  const r = await resolveLockfile(uri);
  if (r.error) {
    ui.error("LockSettle: " + vscode.workspace.asRelativePath(uri) + " cannot be regenerated (" + r.error + ").");
    return done({ status: r.error });
  }
  if (running.has(r.real)) {
    ui.info("LockSettle: " + vscode.workspace.asRelativePath(uri) + " is already being regenerated. Wait for its task to finish.");
    return done({ status: "running" });
  }
  running.add(r.real);
  try {
    return await regenerateLockfile(uri, r);
  } finally {
    running.delete(r.real);
  }
}

async function regenerateLockfile(uri, r) {
  const { real, info, folder } = r;
  const lockDir = path.dirname(real);
  const relLock = vscode.workspace.asRelativePath(uri, false);
  const roots = await realRoots();

  const openDoc = vscode.workspace.textDocuments.find((d) => d.uri.toString() === uri.toString());
  if (openDoc && openDoc.isDirty) {
    ui.warn("LockSettle: " + relLock + " has unsaved edits. Save or revert them first.");
    return done({ status: "dirty" });
  }

  let lockText;
  try {
    lockText = await readCapped(real, MAX_LOCK_BYTES);
  } catch (_) {
    lockText = null;
  }
  if (lockText === null || !core.hasConflictMarkers(lockText)) {
    ui.info("LockSettle: " + relLock + " has no merge conflict markers. Nothing to regenerate.");
    await checkFile(uri);
    render();
    return done({ status: "no-conflict" });
  }

  // 1. The manifest must be resolved first.
  const manifestPath = path.join(lockDir, info.manifest);
  if (!fs.existsSync(manifestPath)) {
    ui.error("LockSettle: " + info.manifest + " was not found next to " + relLock + ". The lockfile is regenerated from it, so it has to exist.");
    return done({ status: "manifest-missing" });
  }
  const bad = await findConflictedManifest(lockDir, info, roots, true);
  if (bad) {
    const badUri = vscode.Uri.file(bad.path);
    const rel = vscode.workspace.asRelativePath(badUri);
    try {
      const doc = await vscode.workspace.openTextDocument(badUri);
      const pos = new vscode.Position(bad.line, 0);
      await vscode.window.showTextDocument(doc, { selection: new vscode.Range(pos, pos), preview: false });
    } catch (_) { /* ignore */ }
    ui.error("Resolve the merge conflict in " + rel + " first. " + info.name + " is regenerated from it, so it must be conflict-free.");
    return done({ status: "manifest-conflicted", manifest: bad.path });
  }

  // 2. Pick the command and the base.
  const c = cfg();
  let yarnFlavor;
  let poetryMajor;
  if (info.ecosystem === "yarn") {
    let pj = null;
    try {
      pj = await readCapped(manifestPath, MAX_MANIFEST_BYTES);
    } catch (_) { /* ignore */ }
    let hasYarnrcYml = false;
    for (let d = lockDir; ; d = path.dirname(d)) {
      if (fs.existsSync(path.join(d, ".yarnrc.yml"))) {
        hasYarnrcYml = true;
        break;
      }
      if (!roots.some((root) => core.isInside(root, path.dirname(d))) || path.dirname(d) === d) break;
    }
    yarnFlavor = core.detectYarnFlavor({ packageJsonText: pj, hasYarnrcYml, lockText, setting: c.yarnFlavor });
  }
  if (info.ecosystem === "poetry") poetryMajor = core.detectPoetryMajor(core.oursSide(lockText), c.poetryVersion);
  const cmd = core.resolveCommand(info.ecosystem, { overrides: c.overrides, yarnFlavor, poetryMajor });
  const base = core.resolveBase(info.ecosystem, c.base);

  let ctx = null;
  if (base !== "keep") {
    ctx = await core.gitContext(real);
    if (!ctx.ok) {
      ui.error("LockSettle: git refused for " + relLock + " (" + ctx.reason + "). " + gitReasonText(ctx.reason));
      return done({ status: "git-refused", reason: ctx.reason });
    }
  }

  const relDir = path.dirname(relLock);
  const detail = core.describePlan({ lockName: info.name, relDir, base, argv: cmd.argv, manifest: info.manifest });
  const ok = await ui.confirm("Regenerate " + relLock + "?", detail, "Run");
  if (!ok) return done({ status: "cancelled" });

  // 3. Base.
  if (ctx) {
    const co = await core.checkoutSide(ctx, base);
    if (!co.ok) {
      ui.error("LockSettle: git checkout --" + base + " failed for " + relLock + ": " + (co.stderr.trim() || "exit " + co.code));
      return done({ status: "checkout-failed", stderr: co.stderr });
    }
  }

  // 4. Visible task in the lockfile's folder.
  const execOpts = { cwd: lockDir };
  const execution =
    process.platform === "win32"
      ? new vscode.ShellExecution(cmd.argv[0], cmd.argv.slice(1).map((a) => ({ value: a, quoting: vscode.ShellQuoting.Strong })), execOpts)
      : new vscode.ProcessExecution(cmd.argv[0], cmd.argv.slice(1), execOpts);
  const task = new vscode.Task(
    { type: "locksettle", lockfile: relLock, ecosystem: info.ecosystem },
    folder,
    "Regenerate " + relLock,
    SOURCE,
    execution,
    []
  );
  task.presentationOptions = { reveal: vscode.TaskRevealKind.Always, panel: vscode.TaskPanelKind.Dedicated, clear: true, showReuseMessage: false };

  const pending = { events: [] };
  pending.listener = vscode.tasks.onDidEndTaskProcess((e) => pending.events.push(e));
  let te;
  try {
    te = await vscode.tasks.executeTask(task);
  } catch (e) {
    pending.listener.dispose();
    ui.error("LockSettle: could not start the task: " + String(e && e.message ? e.message : e));
    return done({ status: "task-failed" });
  }
  const exitCode = await waitForTask(te, pending);
  const base_ = { argv: cmd.argv, cwd: lockDir, base, variant: cmd.variant, exitCode };

  // 5. Verify.
  let after = null;
  try {
    after = await readCapped(real, MAX_LOCK_BYTES);
  } catch (_) { /* ignore */ }
  await checkFile(uri);
  render();
  if (exitCode !== 0) {
    const restore = ctx && after !== null && !core.hasConflictMarkers(after)
      ? " It now holds " + (base === "theirs" ? "the incoming side" : "your side") + " (git checkout --" + base + "). Run \"git checkout -m -- " + ctx.rel + "\" to bring the conflict back."
      : "";
    ui.error("LockSettle: " + cmd.argv[0] + " exited with " + (exitCode === undefined ? "an error" : "code " + exitCode) + ". See the task terminal for details. " + relLock + " was not staged." + restore);
    return done(Object.assign({ status: "exit-failed" }, base_));
  }
  if (after === null || core.hasConflictMarkers(after)) {
    ui.warn("LockSettle: " + cmd.argv[0] + " finished but " + relLock + " still has conflict markers. Try the \"ours\" base (locksettle.lockfileBase) and run it again.");
    return done(Object.assign({ status: "markers-remain" }, base_));
  }
  const review = base === "keep" ? "" : " Review the diff first: lockfile-only pins from " + (base === "theirs" ? "your" : "the other") + " side may have changed.";
  const choice = await ui.info(relLock + " regenerated with no conflict markers left." + review, "Stage lockfile", "Open");
  if (choice === "Open") vscode.window.showTextDocument(uri);
  if (choice !== "Stage lockfile") return done(Object.assign({ status: "done" }, base_));
  const st = await stageLockfile(uri, true);
  return done(Object.assign({}, base_, { status: st.status === "staged" ? "staged" : "stage-failed", stage: st }));
}

function gitReasonText(reason) {
  switch (reason) {
    case "not-a-repo":
      return "The folder is not inside a git repository.";
    case "outside-worktree":
      return "The repository's work tree does not contain this file (check core.worktree).";
    case "filter-attribute":
      return "The lockfile has a git filter attribute, which would run a program. Resolve it manually.";
    default:
      return "";
  }
}

async function stageLockfile(arg, internal) {
  const uri = arg instanceof vscode.Uri ? arg : undefined;
  if (!uri) return { status: "cancelled" };
  if (!vscode.workspace.isTrusted) return { status: "untrusted" };
  const r = await resolveLockfile(uri);
  if (r.error) return { status: r.error };
  let text = null;
  try {
    text = await readCapped(r.real, MAX_LOCK_BYTES);
  } catch (_) { /* ignore */ }
  if (text === null || core.hasConflictMarkers(text)) {
    ui.warn("LockSettle: " + vscode.workspace.asRelativePath(uri) + " still has conflict markers, not staging it.");
    return { status: "markers-remain" };
  }
  const ctx = await core.gitContext(r.real);
  if (!ctx.ok) {
    ui.error("LockSettle: git refused (" + ctx.reason + "). " + gitReasonText(ctx.reason));
    return { status: "git-refused", reason: ctx.reason };
  }
  const res = await core.stage(ctx);
  if (!res.ok) {
    ui.error("LockSettle: git add failed: " + (res.stderr.trim() || "exit " + res.code));
    return { status: "stage-failed" };
  }
  if (!internal) lastResult = { status: "staged" };
  ui.info("LockSettle: staged " + ctx.rel + ".");
  return { status: "staged" };
}

// ---------------------------------------------------------------------------------------
// Activation
// ---------------------------------------------------------------------------------------

function activate(context) {
  diagnostics = vscode.languages.createDiagnosticCollection("locksettle");
  statusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 50);
  statusItem.command = "locksettle.showConflicted";
  disposed = false;
  treeView = vscode.window.createTreeView(VIEW_ID, { treeDataProvider: lockfilesProvider });
  context.subscriptions.push(diagnostics, statusItem, codeLensEmitter, treeEmitter, treeView);

  context.subscriptions.push(
    vscode.commands.registerCommand("locksettle.regenerate", (arg) => regenerate(arg)),
    vscode.commands.registerCommand("locksettle.stage", (arg) => stageLockfile(arg, false)),
    vscode.commands.registerCommand("locksettle.rescan", () => scanAll()),
    vscode.commands.registerCommand("locksettle.openLockfile", (arg) => openLockfile(arg)),
    vscode.commands.registerCommand("locksettle.openManifest", (arg) => openManifest(arg)),
    vscode.commands.registerCommand("locksettle.showConflicted", async () => {
      const u = await pickConflicted("Conflicted lockfiles - pick one to regenerate");
      if (u) return regenerate(u);
      return undefined;
    })
  );

  const selector = { scheme: "file", pattern: GLOB };
  context.subscriptions.push(
    vscode.languages.registerCodeLensProvider(selector, {
      onDidChangeCodeLenses: codeLensEmitter.event,
      provideCodeLenses(doc) {
        const e = conflicted.get(doc.uri.toString());
        if (!e || !cfg().codeLens) return [];
        const range = new vscode.Range(0, 0, 0, 0);
        return [
          new vscode.CodeLens(range, { title: "$(sync) LockSettle: regenerate " + e.info.name + " (don't edit by hand)", command: "locksettle.regenerate", arguments: [doc.uri] }),
        ];
      },
    }),
    vscode.languages.registerCodeActionsProvider(
      selector,
      {
        provideCodeActions(doc, _range, ctx) {
          const ds = ctx.diagnostics.filter((d) => d.source === SOURCE);
          if (!ds.length) return [];
          const a = new vscode.CodeAction("Regenerate " + path.basename(doc.uri.fsPath) + " with LockSettle", vscode.CodeActionKind.QuickFix);
          a.command = { title: a.title, command: "locksettle.regenerate", arguments: [doc.uri] };
          a.diagnostics = ds;
          a.isPreferred = true;
          return [a];
        },
      },
      { providedCodeActionKinds: [vscode.CodeActionKind.QuickFix] }
    )
  );

  const watcher = vscode.workspace.createFileSystemWatcher(GLOB);
  const onFile = (u) => {
    checkFile(u).then(render).catch(() => {});
  };
  context.subscriptions.push(
    watcher,
    watcher.onDidChange(onFile),
    watcher.onDidCreate(onFile),
    watcher.onDidDelete((u) => {
      conflicted.delete(u.toString());
      render();
    }),
    vscode.workspace.onDidChangeWorkspaceFolders(() => scheduleScan(200)),
    // Saving a manifest (or a lockfile) updates the "manifest conflicted" / "ready" state at once,
    // without waiting for the watcher or the poll.
    vscode.workspace.onDidSaveTextDocument((doc) => {
      if (doc.uri.scheme === "file" && (MANIFEST_NAMES.has(path.basename(doc.uri.fsPath)) || core.lockfileInfo(doc.uri.fsPath))) scheduleScan(150);
    }),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (!e.affectsConfiguration(SECTION)) return;
      if (cfg().enabled && vscode.window.state.focused) startPolling();
      else if (!cfg().enabled) stopPolling();
      scheduleScan(100);
    }),
    vscode.workspace.onDidGrantWorkspaceTrust(() => {
      hookGit();
      scheduleScan(100);
    }),
    { dispose: () => gitListeners.forEach((l) => l.dispose()) },
    { dispose: () => clearTimeout(scanTimer) }
  );

  // The watcher is the fast path; the focused-only poll covers file systems where watching
  // is unavailable (see startPolling).
  if (vscode.window.state.focused) startPolling();
  context.subscriptions.push(
    vscode.window.onDidChangeWindowState((w) => onWindowFocus(w.focused)),
    {
      dispose: () => {
        disposed = true;
        stopPolling();
      },
    }
  );

  hookGit();
  scheduleScan(0);

  return {
    getConflicted: () => Array.from(conflicted.values()).map((e) => ({ path: e.uri.fsPath, ecosystem: e.info.ecosystem, blocks: e.blocks.length, manifestConflicted: !!e.manifest })),
    getTreeItems: () => lockfilesProvider.getChildren().map((e) => lockfilesProvider.getTreeItem(e)),
    getBadge: () => (treeView && treeView.badge ? treeView.badge.value : 0),
    isPolling: () => !!pollTimer,
    simulateWindowFocus: (focused) => onWindowFocus(!!focused),
    getReadCount: () => readCount,
    getReadCacheSize: () => readCache.size,
    getStatusText: () => (statusItem.text || ""),
    quickPickItems,
    rescan: () => scanAll(),
    getLastResult: () => lastResult,
    setUi: (o) => Object.assign(ui, o || {}),
  };
}

function deactivate() {
  disposed = true;
  stopPolling();
  clearTimeout(scanTimer);
}

module.exports = { activate, deactivate };
