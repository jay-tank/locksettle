"use strict";

// In-editor test, loaded by VS Code through --extensionTestsPath. Expects the workspace built
// by test/run-vscode.js and its JSON config in LS_TEST_CONFIG.

const vscode = require("vscode");
const fs = require("fs");
const path = require("path");
const { git } = require("../fixtures");
const core = require("../../core");

const results = [];
function check(name, cond, detail) {
  results.push({ name, ok: !!cond, detail: cond ? undefined : String(detail) });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, timeoutMs, label) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    try {
      const v = await fn();
      if (v) return v;
    } catch (_) { /* retry */ }
    await sleep(200);
  }
  throw new Error("timeout waiting for " + label);
}
const unmerged = (root) => git(root, "ls-files", "-u", "-z").split("\0").filter(Boolean).map((r) => r.slice(r.indexOf("\t") + 1));
const lsDiags = (p) => vscode.languages.getDiagnostics(vscode.Uri.file(p)).filter((d) => d.source === "LockSettle");
const setCfg = (k, v) => vscode.workspace.getConfiguration("locksettle").update(k, v, vscode.ConfigurationTarget.Global);

async function run() {
  const cfg = JSON.parse(fs.readFileSync(process.env.LS_TEST_CONFIG, "utf8"));
  const { mode, mainRoot, hostileRoot, escRoot, outsideDir, markerDir, resultFile, shotDir } = cfg;
  const realMain = fs.realpathSync(mainRoot);

  // UI capture.
  const log = { confirms: [], infos: [], warns: [], errors: [], notifies: [] };
  let confirmAnswer = true;
  let confirmHold = null;
  let infoAnswer;
  const ui = {
    confirm: async (m, detail) => {
      log.confirms.push({ m, detail });
      if (confirmHold) await confirmHold;
      return confirmAnswer;
    },
    info: async (m) => {
      log.infos.push(m);
      return infoAnswer;
    },
    warn: async (m) => {
      log.warns.push(m);
      return undefined;
    },
    error: async (m) => {
      log.errors.push(m);
      return undefined;
    },
    notifyConflict: async (m) => {
      log.notifies.push(m);
      return undefined;
    },
  };
  const started = [];
  const startSub = vscode.tasks.onDidStartTask((e) => started.push(e.execution.task));

  try {
    const ext = vscode.extensions.getExtension("jaytankdev.locksettle");
    const api = ext.isActive ? ext.exports : await ext.activate();
    api.setUi(ui);
    const regen = (p) => vscode.commands.executeCommand("locksettle.regenerate", vscode.Uri.file(p));

    if (mode === "untrusted") {
      check("untrusted: workspace is not trusted", !vscode.workspace.isTrusted);
      const lock = path.join(mainRoot, "package-lock.json");
      await waitFor(() => lsDiags(lock).length > 0, 20000, "diagnostic in untrusted mode").catch(() => {});
      check("untrusted: read-only diagnostic still shown", lsDiags(lock).length === 1);
      check("untrusted: status bar shows conflicts", /conflicted lockfile/.test(api.getStatusText()), api.getStatusText());
      await vscode.commands.executeCommand("workbench.view.extension.locksettle");
      await waitFor(() => api.getTreeItems().length === 7, 20000, "untrusted rows").catch(() => {});
      check("untrusted: view still lists the 7 conflicted lockfiles (read-only)", api.getTreeItems().length === 7, api.getTreeItems().map((i) => i.label).join(","));
      check("untrusted: badge = 7", api.getBadge() === 7, api.getBadge());
      const rowLock = api.getTreeItems().find((i) => i.label === "main/package-lock.json");
      const rIn = rowLock && (await vscode.commands.executeCommand("locksettle.regenerate", { uri: rowLock.command.arguments[0] }));
      check("untrusted: inline Regenerate refused", rIn && rIn.status === "untrusted", JSON.stringify(rIn));
      const oL = rowLock && (await vscode.commands.executeCommand(rowLock.command.command, ...rowLock.command.arguments));
      check("untrusted: row click still opens the lockfile (read-only)", oL && oL.status === "opened", JSON.stringify(oL));
      const before = fs.readFileSync(lock, "utf8");
      const r = await regen(lock);
      check("untrusted: regenerate refused", r && r.status === "untrusted", JSON.stringify(r));
      const rc = await regen(path.join(hostileRoot, "Cargo.lock"));
      check("untrusted: cargo regenerate refused", rc && rc.status === "untrusted", JSON.stringify(rc));
      const s = await vscode.commands.executeCommand("locksettle.stage", vscode.Uri.file(lock));
      check("untrusted: stage refused", s && s.status === "untrusted", JSON.stringify(s));
      await sleep(1500);
      check("untrusted: no modal shown", log.confirms.length === 0);
      check("untrusted: no task started", started.length === 0, started.map((t) => t.name).join(","));
      check("untrusted: lockfile untouched", fs.readFileSync(lock, "utf8") === before);
      check("untrusted: still unmerged in git", unmerged(mainRoot).includes("package-lock.json"));
      check("untrusted: no hostile marker files", fs.readdirSync(markerDir).length === 0, fs.readdirSync(markerDir).join(","));
      return;
    }

    check("workspace is trusted", vscode.workspace.isTrusted);

    // --- detection ---
    const expected = [
      path.join(mainRoot, "package-lock.json"),
      path.join(mainRoot, "packages/web/package-lock.json"),
      path.join(mainRoot, "-weird/yarn.lock"),
      path.join(mainRoot, "py/poetry.lock"),
      path.join(hostileRoot, "Cargo.lock"),
      path.join(hostileRoot, "gems/Gemfile.lock"),
      path.join(escRoot, "go.sum"),
    ];
    const webLock0 = expected[1];
    await waitFor(() => expected.every((p) => api.getConflicted().some((c) => c.path === p)), 30000, "all conflicted lockfiles");
    const got = api.getConflicted().map((c) => c.path);
    check("detects all 7 real conflicted lockfiles", expected.every((p) => got.includes(p)), got.join(","));
    check("symlinked lockfile pointing outside is ignored", !got.includes(path.join(hostileRoot, "linked/package-lock.json")), got.join(","));
    check("only lockfiles reported (7)", got.length === 7, got.join(","));
    check("no diagnostic on decoy JSON with quoted markers", vscode.languages.getDiagnostics(vscode.Uri.file(path.join(mainRoot, "docs/notes.json"))).length === 0);
    const d = lsDiags(expected[0]);
    check("diagnostic on package-lock.json line 1", d.length === 1 && d[0].range.start.line === 0 && d[0].code === "LS001" && /Don't edit it by hand/.test(d[0].message), JSON.stringify(d));
    check("status bar item while conflicted", api.getStatusText() === "$(lock) LockSettle: 7 conflicted lockfiles", api.getStatusText());
    check("Show conflicted lockfiles items", api.quickPickItems().length === 7);
    const cmds = await vscode.commands.getCommands(true);
    check("commands registered", ["locksettle.regenerate", "locksettle.showConflicted", "locksettle.stage", "locksettle.rescan", "locksettle.openLockfile", "locksettle.openManifest"].every((c) => cmds.includes(c)));

    // --- activity bar view ---
    const pj = ext.packageJSON;
    const container = ((pj.contributes.viewsContainers || {}).activitybar || []).find((c) => c.id === "locksettle");
    check("activity bar container contributed", container && container.title === "LockSettle" && container.icon === "media/activity.svg", JSON.stringify(container));
    check("activity bar icon file exists", fs.existsSync(path.join(ext.extensionPath, "media", "activity.svg")));
    const viewDef = ((pj.contributes.views || {}).locksettle || [])[0];
    check("view contributed in the container", viewDef && viewDef.id === "locksettle.lockfiles", JSON.stringify(viewDef));
    check("onView activation event", pj.activationEvents.includes("onView:locksettle.lockfiles"));
    const itemMenus = pj.contributes.menus["view/item/context"] || [];
    check("inline Regenerate and Open manifest row actions", ["locksettle.regenerate", "locksettle.openManifest"].every((c) => itemMenus.some((m) => m.command === c && /^inline/.test(m.group))), JSON.stringify(itemMenus));
    check("Rescan button in the view title", (pj.contributes.menus["view/title"] || []).some((m) => m.command === "locksettle.rescan" && m.group === "navigation"));
    const welcomes = pj.contributes.viewsWelcome || [];
    check("empty state explains what it watches, with a Rescan button", welcomes.some((w) => /config\.locksettle\.enabled && isWorkspaceTrusted/.test(w.when) && /watches package-lock\.json/.test(w.contents) && /command:locksettle\.rescan/.test(w.contents)), JSON.stringify(welcomes));
    check("empty states for turned off and untrusted", welcomes.some((w) => w.when === "!config.locksettle.enabled") && welcomes.some((w) => /!isWorkspaceTrusted/.test(w.when) && /workbench\.trust\.manage/.test(w.contents)));
    await vscode.commands.executeCommand("workbench.view.extension.locksettle");
    const rows = api.getTreeItems();
    const labels = rows.map((i) => i.label);
    check("view opens with one row per conflicted lockfile (7)", rows.length === 7, labels.join(","));
    check("row labels are the lockfile paths", ["main/package-lock.json", "main/packages/web/package-lock.json", "main/-weird/yarn.lock", "main/py/poetry.lock", "hostile/Cargo.lock", "hostile/gems/Gemfile.lock", "esc/go.sum"].every((l) => labels.includes(l)), labels.join(","));
    check("row labels are all different", new Set(labels).size === labels.length);
    const row = (l) => rows.find((i) => i.label === l);
    check("description: ecosystem + ready to regenerate", row("main/package-lock.json").description === "npm - ready to regenerate", row("main/package-lock.json").description);
    check("description: ecosystem + manifest conflicted", row("main/packages/web/package-lock.json").description === "npm - manifest conflicted", row("main/packages/web/package-lock.json").description);
    check("descriptions for other ecosystems", row("hostile/Cargo.lock").description === "cargo - ready to regenerate" && row("main/py/poetry.lock").description === "poetry - ready to regenerate" && row("esc/go.sum").description === "go - ready to regenerate", rows.map((i) => i.description).join(","));
    const webRow = row("main/packages/web/package-lock.json");
    check("icons: error when the manifest blocks, warning when ready", webRow.iconPath.id === "error" && row("main/package-lock.json").iconPath.id === "warning");
    check("contextValue drives the inline actions", webRow.contextValue === "lockfile.manifestConflicted" && row("main/package-lock.json").contextValue === "lockfile.ready");
    const lockLine = core.findConflictBlocks(fs.readFileSync(expected[0], "utf8"))[0].start;
    check("tooltip: path:line + full message + manifest state", String(row("main/package-lock.json").tooltip).startsWith("main/package-lock.json:" + (lockLine + 1) + "\npackage-lock.json has merge conflicts") && /Manifest main\/package\.json is conflict-free/.test(row("main/package-lock.json").tooltip), row("main/package-lock.json").tooltip);
    check("tooltip names the conflicted manifest and line", /Manifest main\/packages\/web\/package\.json:\d+ still has conflict markers/.test(webRow.tooltip), webRow.tooltip);
    check("badge = conflicted lockfiles (7)", api.getBadge() === 7, api.getBadge());

    // Row click: opens the lockfile at its first conflict block; forged args are rejected.
    const click = row("main/package-lock.json").command;
    const oRes = await vscode.commands.executeCommand(click.command, ...click.arguments);
    const oEd = vscode.window.activeTextEditor;
    check("row click opens the lockfile at its first conflict", oRes && oRes.status === "opened" && oEd && oEd.document.uri.fsPath === expected[0] && oEd.selection.active.line === lockLine, JSON.stringify(oRes) + " " + (oEd && oEd.selection.active.line));
    const forged = [
      vscode.Uri.file(path.join(outsideDir, "package-lock.json")),
      { uri: vscode.Uri.file(path.join(hostileRoot, "linked/package-lock.json")) },
      vscode.Uri.file(path.join(mainRoot, "docs/notes.json")),
      expected[0],
      { path: expected[0] },
      undefined,
    ];
    let forgedOk = true;
    for (const f of forged) {
      const r = await vscode.commands.executeCommand("locksettle.openLockfile", f);
      if (!r || r.status === "opened") forgedOk = false;
    }
    check("open command rejects forged/outside/non-conflicted args", forgedOk);
    const oM = await vscode.commands.executeCommand("locksettle.openManifest", { uri: vscode.Uri.file(webLock0) });
    const mEd = vscode.window.activeTextEditor;
    const webPjLine = core.findConflictBlocks(fs.readFileSync(path.join(mainRoot, "packages/web/package.json"), "utf8"))[0].start;
    check("inline Open manifest opens the conflicted package.json at its conflict", oM && oM.status === "opened" && mEd && mEd.document.uri.fsPath === path.join(realMain, "packages/web/package.json") && mEd.selection.active.line === webPjLine, JSON.stringify(oM));
    const oM2 = await vscode.commands.executeCommand("locksettle.openManifest", vscode.Uri.file(expected[0]));
    check("Open manifest opens the paired package.json when it is clean", oM2 && oM2.status === "opened" && oM2.path === path.join(realMain, "package.json"), JSON.stringify(oM2));
    const oM3 = await vscode.commands.executeCommand("locksettle.openManifest", vscode.Uri.file(path.join(outsideDir, "package-lock.json")));
    check("Open manifest rejects a lockfile that is not a live conflict", oM3 && oM3.status === "not-conflicted", JSON.stringify(oM3));

    // Polling fallback: runs only while focused, stops on blur, never re-reads unchanged files.
    check("polling runs only when the window is focused", api.isPolling() === vscode.window.state.focused, api.isPolling() + " " + vscode.window.state.focused);
    api.simulateWindowFocus(false);
    check("polling stops when the window loses focus", api.isPolling() === false);
    api.simulateWindowFocus(true);
    check("polling restarts when the window regains focus", api.isPolling() === true);
    await api.rescan();
    const reads0 = api.getReadCount();
    await api.rescan();
    await api.rescan();
    check("rescans do not re-read unchanged files", api.getReadCount() === reads0, reads0 + " -> " + api.getReadCount());
    fs.appendFileSync(path.join(escRoot, "go.sum"), "example.com/z v1.0.0 h1:ZZZ=\n");
    await api.rescan();
    check("a changed file is re-read once", api.getReadCount() === reads0 + 1, reads0 + " -> " + api.getReadCount());

    // Visual check: container open with conflicted lockfiles listed.
    await vscode.commands.executeCommand("workbench.view.extension.locksettle");
    await sleep(6000);
    fs.writeFileSync(path.join(shotDir, "shot-trusted"), "1");
    await waitFor(() => fs.existsSync(path.join(shotDir, "shot-done-trusted")), 20000, "screenshot").catch(() => {});
    check("screenshot taken", fs.existsSync(path.join(shotDir, "shot-done-trusted")));

    const lockUri = vscode.Uri.file(expected[0]);
    await vscode.window.showTextDocument(lockUri);
    const lenses = await waitFor(async () => {
      const l = await vscode.commands.executeCommand("vscode.executeCodeLensProvider", lockUri);
      return l && l.some((x) => x.command && x.command.command === "locksettle.regenerate") ? l : null;
    }, 10000, "codelens").catch(() => []);
    check("CodeLens on the lockfile", lenses.some((x) => x.command && /regenerate package-lock\.json/.test(x.command.title)));
    const actions = await vscode.commands.executeCommand("vscode.executeCodeActionProvider", lockUri, new vscode.Range(0, 0, 0, 1));
    check("Quick Fix offered", (actions || []).some((a) => a.title === "Regenerate package-lock.json with LockSettle"), (actions || []).map((a) => a.title).join(","));

    // --- watcher + notification for a new conflict ---
    fs.mkdirSync(path.join(mainRoot, "extra"), { recursive: true });
    fs.writeFileSync(path.join(mainRoot, "extra/pyproject.toml"), "[project]\nname = \"extra\"\n");
    fs.writeFileSync(path.join(mainRoot, "extra/uv.lock"), "version = 1\n<<<<<<< HEAD\na\n=======\nb\n>>>>>>> other\n");
    await waitFor(() => log.notifies.some((m) => /extra/.test(m)), 40000, "notification").catch(() => {});
    check("notification for a newly conflicted lockfile", log.notifies.some((m) => m === "main/extra/uv.lock has merge conflicts. Don't edit it by hand - LockSettle can regenerate it." || /extra\/uv\.lock has merge conflicts\. Don't edit it by hand - LockSettle can regenerate it\./.test(m)), JSON.stringify(log.notifies));

    // --- refusal: manifest still conflicted ---
    const nStart = started.length;
    const webLock = path.join(mainRoot, "packages/web/package-lock.json");
    const rWeb = await regen(webLock);
    check("refuses when package.json is conflicted", rWeb && rWeb.status === "manifest-conflicted" && rWeb.manifest === path.join(realMain, "packages/web/package.json"), JSON.stringify(rWeb));
    const ae = vscode.window.activeTextEditor;
    check("opens the conflicted package.json", ae && ae.document.uri.fsPath === path.join(realMain, "packages/web/package.json"), ae && ae.document.uri.fsPath);
    check("refusal message tells to resolve it first", log.errors.some((m) => /Resolve the merge conflict in .*packages\/web\/package\.json first/.test(m)), JSON.stringify(log.errors));
    check("no modal and no task on refusal", log.confirms.length === 0 && started.length === nStart);

    // Resolving and saving the manifest flips the row to "ready to regenerate" (save path).
    const webPj = await vscode.workspace.openTextDocument(path.join(mainRoot, "packages/web/package.json"));
    const we = new vscode.WorkspaceEdit();
    we.replace(webPj.uri, new vscode.Range(0, 0, webPj.lineCount, 0), JSON.stringify({ name: "web", version: "1.0.0", dependencies: { "left-pad": "3.0.0" } }, null, 2) + "\n");
    await vscode.workspace.applyEdit(we);
    await webPj.save();
    const webReady = await waitFor(() => {
      const r = api.getTreeItems().find((i) => i.label === "main/packages/web/package-lock.json");
      return r && r.description === "npm - ready to regenerate" ? r : null;
    }, 8000, "web row ready").catch(() => null);
    check("saving the resolved manifest flips the row to ready to regenerate", webReady && webReady.contextValue === "lockfile.ready" && webReady.iconPath.id === "warning");

    // --- cancel shows the default command and base, runs nothing ---
    confirmAnswer = false;
    let release;
    confirmHold = new Promise((r) => (release = r));
    const pCancel = regen(path.join(hostileRoot, "Cargo.lock"));
    await waitFor(() => log.confirms.length > 0, 10000, "modal").catch(() => {});
    const rTwice = await regen(path.join(hostileRoot, "Cargo.lock"));
    check("second regenerate of the same lockfile while one is open is refused", rTwice && rTwice.status === "running", JSON.stringify(rTwice));
    release();
    confirmHold = null;
    const rCancel = await pCancel;
    check("cancel returns cancelled", rCancel && rCancel.status === "cancelled", JSON.stringify(rCancel));
    const cd = log.confirms[log.confirms.length - 1];
    check("modal shows the exact default cargo command and checkout step", cd && /git checkout --ours -- Cargo\.lock/.test(cd.detail) && /cargo update --workspace/.test(cd.detail), cd && cd.detail);
    check("ours modal: other branch's lockfile-only pins may change, review the diff", cd && /The other branch's Cargo\.lock changes are dropped and re-resolved from Cargo\.toml\./.test(cd.detail) && /pinned only in Cargo\.lock \(not in Cargo\.toml\) may change/.test(cd.detail) && /Review the lockfile diff before you commit\./.test(cd.detail), cd && cd.detail);
    check("cancel ran no task and left the lockfile conflicted", started.length === nStart && core.hasConflictMarkers(fs.readFileSync(path.join(hostileRoot, "Cargo.lock"), "utf8")));
    confirmAnswer = true;

    // --- npm: keep markers, stubbed command, stage ---
    const cleanLock = JSON.stringify({ name: "app", lockfileVersion: 3, packages: { "": { dependencies: { "left-pad": "1.1.0", "right-pad": "1.2.0" } } } }, null, 2) + "\n";
    const npmArgv = ["node", "-e", "require('fs').writeFileSync('package-lock.json', " + JSON.stringify(cleanLock) + ")"];
    await setCfg("commands.npm", npmArgv);
    infoAnswer = "Stage lockfile";
    const rNpm = await vscode.commands.executeCommand("locksettle.regenerate", { uri: vscode.Uri.file(expected[0]) });
    const tNpm = started[started.length - 1];
    check("npm task started", tNpm && tNpm.source === "LockSettle" && tNpm.name === "Regenerate main/package-lock.json" || (tNpm && /Regenerate .*package-lock\.json/.test(tNpm.name)), tNpm && tNpm.name);
    const ex = tNpm && tNpm.execution;
    check("npm task runs the configured command", ex && ex.process === "node" && JSON.stringify(ex.args) === JSON.stringify(npmArgv.slice(1)), ex && JSON.stringify({ p: ex.process, a: ex.args }));
    check("npm task cwd is the lockfile folder", ex && ex.options && ex.options.cwd === realMain, ex && ex.options && ex.options.cwd);
    const npmDetail = log.confirms[log.confirms.length - 1].detail;
    check("npm modal says markers are kept (npm merges them)", /Keep package-lock\.json as it is/.test(npmDetail) && npmDetail.includes("node -e"), npmDetail);
    check("npm result staged, exit 0", rNpm && rNpm.status === "staged" && rNpm.exitCode === 0 && rNpm.base === "keep", JSON.stringify(rNpm));
    check("npm lockfile clean on disk", fs.readFileSync(expected[0], "utf8") === cleanLock);
    check("npm lockfile no longer unmerged in git", !unmerged(mainRoot).includes("package-lock.json"), unmerged(mainRoot).join(","));
    await waitFor(() => lsDiags(expected[0]).length === 0, 5000, "diagnostic cleared").catch(() => {});
    check("npm diagnostic cleared", lsDiags(expected[0]).length === 0);
    check("npm row removed from the view, badge updated", !api.getTreeItems().some((i) => i.label === "main/package-lock.json") && api.getBadge() === api.getTreeItems().length, api.getBadge());

    // --- yarn in a '-' monorepo subfolder, string override, not staged ---
    await setCfg("commands.yarn", "node -e \"require('fs').writeFileSync('yarn.lock', '# yarn lockfile v1\\n')\"");
    infoAnswer = undefined;
    const yLock = path.join(mainRoot, "-weird/yarn.lock");
    const rY = await regen(yLock);
    const tY = started[started.length - 1];
    check("yarn task cwd is its own subfolder", tY && tY.execution.options.cwd === path.join(realMain, "-weird"), tY && tY.execution.options.cwd);
    check("yarn string override split without a shell", tY && tY.execution.process === "node" && tY.execution.args[0] === "-e" && tY.execution.args.length === 2, tY && JSON.stringify(tY.execution.args));
    check("yarn classic variant, done without staging", rY && rY.status === "done" && rY.variant === "yarn", JSON.stringify(rY));
    check("yarn lockfile regenerated", fs.readFileSync(yLock, "utf8") === "# yarn lockfile v1\n");
    check("yarn still unmerged until staged", unmerged(mainRoot).includes("-weird/yarn.lock"));
    const sY = await vscode.commands.executeCommand("locksettle.stage", vscode.Uri.file(yLock));
    check("Stage lockfile command works with a '-' folder", sY && sY.status === "staged" && !unmerged(mainRoot).includes("-weird/yarn.lock"), JSON.stringify(sY));

    // --- poetry: ours base, poetry 1 detected ---
    await setCfg("commands.poetry", ["node", "-e", ""]);
    const pLock = path.join(mainRoot, "py/poetry.lock");
    const rP = await regen(pLock);
    const pDetail = log.confirms[log.confirms.length - 1].detail;
    check("poetry plan checks out ours first", /1\. git checkout --ours -- poetry\.lock/.test(pDetail), pDetail);
    check("poetry 1 detected from header", rP && rP.variant === "poetry1", JSON.stringify(rP));
    check("poetry result done with ours content", rP && rP.status === "done" && /version = "2\.1\.0"/.test(fs.readFileSync(pLock, "utf8")), JSON.stringify(rP));

    // --- failing command reports the exit code ---
    await setCfg("lockfileBase", { uv: "keep" });
    await setCfg("commands.uv", ["node", "-e", "process.exit(3)"]);
    const rU = await regen(path.join(mainRoot, "extra/uv.lock"));
    check("failing tool: exit code reported, nothing staged", rU && rU.status === "exit-failed" && rU.exitCode === 3, JSON.stringify(rU));
    await setCfg("lockfileBase", { uv: "ours" });
    const rU2 = await regen(path.join(mainRoot, "extra/uv.lock"));
    check("ours base on an untracked lockfile: checkout fails cleanly", rU2 && rU2.status === "checkout-failed", JSON.stringify(rU2));

    // --- hostile ---
    const cleanCargo = "# This file is automatically @generated by Cargo.\nversion = 3\n";
    await setCfg("commands.cargo", ["node", "-e", "require('fs').writeFileSync('Cargo.lock', " + JSON.stringify(cleanCargo) + ")"]);
    infoAnswer = "Stage lockfile";
    const rC = await regen(path.join(hostileRoot, "Cargo.lock"));
    check("hostile: cargo regenerated and staged with hardened git", rC && rC.status === "staged", JSON.stringify(rC));
    check("ours success message asks to review lockfile-only pins", log.infos.some((m) => /hostile\/Cargo\.lock regenerated with no conflict markers left\. Review the diff first: lockfile-only pins from the other side may have changed\./.test(m) || /Cargo\.lock regenerated with no conflict markers left\. Review the diff first/.test(m)), JSON.stringify(log.infos));
    check("hostile: Cargo.lock no longer unmerged", !unmerged(hostileRoot).includes("Cargo.lock"));
    const nG = log.confirms.length;
    const rG = await regen(path.join(hostileRoot, "gems/Gemfile.lock"));
    check("hostile: filter attribute on Gemfile.lock refused before the modal", rG && rG.status === "git-refused" && rG.reason === "filter-attribute" && log.confirms.length === nG, JSON.stringify(rG));
    const rE = await regen(path.join(escRoot, "go.sum"));
    check("hostile: core.worktree pointing outside refused", rE && rE.status === "git-refused" && rE.reason === "outside-worktree", JSON.stringify(rE));
    const outsideLock = path.join(outsideDir, "package-lock.json");
    const outBefore = fs.readFileSync(outsideLock, "utf8");
    const rL = await regen(path.join(hostileRoot, "linked/package-lock.json"));
    check("hostile: symlinked lockfile refused", rL && rL.status === "symlink", JSON.stringify(rL));
    const sL = await vscode.commands.executeCommand("locksettle.stage", vscode.Uri.file(path.join(hostileRoot, "linked/package-lock.json")));
    check("hostile: symlinked lockfile not staged", sL && sL.status === "symlink", JSON.stringify(sL));
    const rO = await regen(outsideLock);
    check("hostile: lockfile outside the workspace refused", rO && rO.status === "outside-workspace", JSON.stringify(rO));
    const rT = await regen(path.join(hostileRoot, "..", "..", "outside", "package-lock.json"));
    check("hostile: ../ path refused", rT && rT.status === "outside-workspace", JSON.stringify(rT));
    check("hostile: outside file untouched", fs.readFileSync(outsideLock, "utf8") === outBefore);
    check("hostile: no fsmonitor/pager/extdiff/hook/filter marker created", fs.readdirSync(markerDir).length === 0, fs.readdirSync(markerDir).join(","));
    check("hostile: no task ran in the outside folder", started.every((t) => !String(t.execution.options && t.execution.options.cwd).startsWith(outsideDir)));

    check("status bar count dropped", /LockSettle: [0-9]+ conflicted/.test(api.getStatusText()) && !/ 7 /.test(api.getStatusText()), api.getStatusText());
    check("badge equals the remaining rows", api.getBadge() === api.getTreeItems().length && api.getBadge() > 0, api.getBadge());

    // Failing tool after an ours checkout tells how to bring the conflict back, and that works.
    const pyLock = path.join(mainRoot, "py/poetry.lock");
    git(mainRoot, "checkout", "-m", "--", "py/poetry.lock");
    check("poetry conflict restored for the failure case", core.hasConflictMarkers(fs.readFileSync(pyLock, "utf8")));
    await api.rescan();
    await setCfg("commands.poetry", ["node", "-e", "process.exit(4)"]);
    const nErr = log.errors.length;
    const rPf = await regen(pyLock);
    const pfMsg = log.errors.slice(nErr).join(" | ");
    check("ours + failing tool: exit-failed, message says how to restore the conflict", rPf && rPf.status === "exit-failed" && rPf.exitCode === 4 && /It now holds your side \(git checkout --ours\)\. Run "git checkout -m -- py\/poetry\.lock" to bring the conflict back\./.test(pfMsg), JSON.stringify(rPf) + " " + pfMsg);
    git(mainRoot, "checkout", "-m", "--", "py/poetry.lock");
    check("the suggested command brings the conflict back", core.hasConflictMarkers(fs.readFileSync(pyLock, "utf8")));

    // Turned off: view empty, badge cleared, no polling; a lockfile change does not bring rows back.
    await setCfg("enabled", false);
    await waitFor(() => api.getTreeItems().length === 0 && api.getBadge() === 0, 5000, "disabled").catch(() => {});
    check("turned off: view empty and badge cleared", api.getTreeItems().length === 0 && api.getBadge() === 0, api.getBadge());
    check("turned off: polling stopped", api.isPolling() === false);
    fs.appendFileSync(path.join(escRoot, "go.sum"), "example.com/y v1.0.0 h1:YYY=\n");
    await api.rescan();
    await sleep(1500);
    check("turned off: changes are not picked up", api.getTreeItems().length === 0 && lsDiags(path.join(escRoot, "go.sum")).length === 0);
    await setCfg("enabled", true);
    const tOn = Date.now();
    await waitFor(() => api.getTreeItems().length > 0 && api.getBadge() === api.getTreeItems().length, 30000, "re-enabled").catch(() => {});
    check("turned on again: rows and badge come back", api.getTreeItems().length > 0 && api.getBadge() === api.getTreeItems().length, JSON.stringify({ ms: Date.now() - tOn, rows: api.getTreeItems().length, badge: api.getBadge(), conflicted: api.getConflicted().length, enabled: vscode.workspace.getConfiguration("locksettle").get("enabled") }));
  } catch (e) {
    check("unexpected exception", false, String(e && e.stack ? e.stack : e));
  } finally {
    startSub.dispose();
    for (const k of ["commands.npm", "commands.yarn", "commands.poetry", "commands.uv", "commands.cargo", "lockfileBase", "enabled"]) {
      try {
        await setCfg(k, undefined);
      } catch (_) { /* ignore */ }
    }
    const passed = results.filter((r) => r.ok).length;
    fs.writeFileSync(resultFile, JSON.stringify({ passed, failed: results.length - passed, results }, null, 2));
  }
}

module.exports = { run };
