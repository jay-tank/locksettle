"use strict";

/**
 * LockSettle core - pure logic, no vscode import, unit-testable in plain Node.
 *
 * - Lockfile table: which file belongs to which ecosystem and which manifest it pairs with.
 * - Conflict marker detection (only real markers at the start of a line, in a complete
 *   <<<<<<< ... ======= ... >>>>>>> block).
 * - Yarn classic vs berry detection, Poetry 1 vs 2 detection.
 * - The regenerate command table, user overrides and the lockfile base strategy.
 * - A hardened git runner (execFile, args array, no shell, global/system config ignored,
 *   core.fsmonitor and hooks off, no pager, paths after "--", capped output and time).
 * - Path confinement helpers (realpath + "is inside" checks).
 */

const fs = require("fs");
const path = require("path");
const { execFile } = require("child_process");

const NULL_DEVICE = process.platform === "win32" ? "\\\\.\\NUL" : "/dev/null";

// ---------------------------------------------------------------------------------------
// Lockfile table
// ---------------------------------------------------------------------------------------

/**
 * ecosystem: key used for settings (locksettle.commands.<ecosystem>, locksettle.lockfileBase).
 * manifest: file in the same folder that must be conflict-free before regenerating.
 */
const LOCKFILES = {
  "package-lock.json": { ecosystem: "npm", manifest: "package.json", tool: "npm" },
  "npm-shrinkwrap.json": { ecosystem: "npm", manifest: "package.json", tool: "npm" },
  "yarn.lock": { ecosystem: "yarn", manifest: "package.json", tool: "yarn" },
  "pnpm-lock.yaml": { ecosystem: "pnpm", manifest: "package.json", tool: "pnpm" },
  "poetry.lock": { ecosystem: "poetry", manifest: "pyproject.toml", tool: "poetry" },
  "uv.lock": { ecosystem: "uv", manifest: "pyproject.toml", tool: "uv" },
  "Cargo.lock": { ecosystem: "cargo", manifest: "Cargo.toml", tool: "cargo" },
  "go.sum": { ecosystem: "go", manifest: "go.mod", tool: "go" },
  "composer.lock": { ecosystem: "composer", manifest: "composer.json", tool: "composer" },
  "Gemfile.lock": { ecosystem: "bundler", manifest: "Gemfile", tool: "bundle" },
  "Pipfile.lock": { ecosystem: "pipenv", manifest: "Pipfile", tool: "pipenv" },
};

const LOCKFILE_NAMES = Object.keys(LOCKFILES);
const ECOSYSTEMS = ["npm", "yarn", "pnpm", "poetry", "uv", "cargo", "go", "composer", "bundler", "pipenv"];

/** Folders never searched for lockfiles or manifests. */
const EXCLUDED_DIRS = ["node_modules", ".git", "vendor", "target", ".venv", "venv", "__pypackages__", ".yarn", "bower_components"];

/**
 * Built-in regenerate commands (argv arrays, never run through a shell by LockSettle).
 * Variants: yarn -> classic (v1) / berry (v2+); poetry -> v1 / v2.
 */
const DEFAULT_COMMANDS = {
  npm: ["npm", "install", "--package-lock-only", "--ignore-scripts"],
  yarn: ["yarn", "install", "--ignore-scripts"],
  yarnBerry: ["yarn", "install", "--mode=update-lockfile"],
  pnpm: ["pnpm", "install", "--lockfile-only", "--ignore-scripts"],
  poetry1: ["poetry", "lock", "--no-update"],
  poetry2: ["poetry", "lock"],
  uv: ["uv", "lock"],
  cargo: ["cargo", "update", "--workspace"],
  go: ["go", "mod", "tidy"],
  composer: ["composer", "update", "--lock", "--no-install", "--no-scripts"],
  bundler: ["bundle", "lock"],
  pipenv: ["pipenv", "lock"],
};

/**
 * Default starting point for the lockfile before the tool runs.
 *   keep  - leave the conflict markers in: npm, yarn (classic and berry) and pnpm parse a
 *           conflicted lockfile themselves and merge both sides.
 *   ours  - `git checkout --ours -- <lockfile>`: the other tools cannot parse markers, so
 *           they start from your side and re-resolve it against the merged manifest.
 *   theirs - `git checkout --theirs -- <lockfile>` (opt-in).
 */
const DEFAULT_BASE = {
  npm: "keep",
  yarn: "keep",
  pnpm: "keep",
  poetry: "ours",
  uv: "ours",
  cargo: "ours",
  go: "ours",
  composer: "ours",
  bundler: "ours",
  pipenv: "ours",
};

/** Ecosystem info for a file path (by base name), or null if it is not a known lockfile. */
function lockfileInfo(filePath) {
  const base = path.basename(String(filePath || ""));
  if (!Object.prototype.hasOwnProperty.call(LOCKFILES, base)) return null;
  const info = LOCKFILES[base];
  return { name: base, ecosystem: info.ecosystem, manifest: info.manifest, tool: info.tool };
}

// ---------------------------------------------------------------------------------------
// Conflict markers
// ---------------------------------------------------------------------------------------

const RE_START = /^<{7}(?:[ \t].*)?$/;
const RE_BASE = /^\|{7}(?:[ \t].*)?$/;
const RE_MID = /^={7}$/;
const RE_END = /^>{7}(?:[ \t].*)?$/;

/**
 * Find complete conflict blocks. Only markers at the very start of a line count, and a block
 * must run <<<<<<< [||||||| ...] ======= >>>>>>> in order. Markers quoted inside strings,
 * indented, or unbalanced are ignored.
 * @param {string} text
 * @returns {{start: number, mid: number, end: number}[]} 0-based line numbers
 */
function findConflictBlocks(text) {
  const blocks = [];
  if (typeof text !== "string" || text.indexOf("<<<<<<<") === -1) return blocks;
  const lines = text.split(/\r?\n/);
  let state = 0; // 0 outside, 1 in ours, 2 in base, 3 in theirs
  let cur = null;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (state === 0) {
      if (RE_START.test(l)) {
        state = 1;
        cur = { start: i, mid: -1, end: -1 };
      }
    } else if (state === 1 || state === 2) {
      if (state === 1 && RE_BASE.test(l)) state = 2;
      else if (RE_MID.test(l)) {
        state = 3;
        cur.mid = i;
      } else if (RE_START.test(l)) {
        cur = { start: i, mid: -1, end: -1 }; // restart on a nested / stray start marker
        state = 1;
      }
    } else if (state === 3) {
      if (RE_END.test(l)) {
        cur.end = i;
        blocks.push(cur);
        cur = null;
        state = 0;
      } else if (RE_START.test(l)) {
        cur = { start: i, mid: -1, end: -1 };
        state = 1;
      }
    }
  }
  return blocks;
}

function hasConflictMarkers(text) {
  return findConflictBlocks(text).length > 0;
}

/** The "ours" side of a conflicted text (used only for header sniffing). */
function oursSide(text) {
  const blocks = findConflictBlocks(text);
  if (!blocks.length) return text;
  const lines = text.split(/\r?\n/);
  const out = [];
  let bi = 0;
  for (let i = 0; i < lines.length; i++) {
    const b = blocks[bi];
    if (b && i >= b.start && i <= b.end) {
      if (i > b.start && i < b.mid && !RE_BASE.test(lines[i])) out.push(lines[i]);
      if (i === b.end) bi++;
      continue;
    }
    out.push(lines[i]);
  }
  return out.join("\n");
}

// ---------------------------------------------------------------------------------------
// Flavor detection
// ---------------------------------------------------------------------------------------

/**
 * Yarn classic or berry.
 * @param {{packageJsonText?: string|null, hasYarnrcYml?: boolean, lockText?: string|null, setting?: string}} o
 * @returns {"classic"|"berry"}
 */
function detectYarnFlavor(o) {
  const setting = o && o.setting;
  if (setting === "classic" || setting === "berry") return setting;
  if (o && typeof o.packageJsonText === "string") {
    const m = /"packageManager"\s*:\s*"yarn@(\d+)/.exec(o.packageJsonText);
    if (m) return parseInt(m[1], 10) >= 2 ? "berry" : "classic";
  }
  if (o && o.hasYarnrcYml) return "berry";
  if (o && typeof o.lockText === "string") {
    if (/^__metadata:\s*$/m.test(o.lockText)) return "berry";
    if (/^# yarn lockfile v1\s*$/m.test(o.lockText)) return "classic";
  }
  return "classic";
}

/**
 * Poetry major version (1 or 2). The lockfile header says which Poetry wrote it:
 * "# This file is automatically @generated by Poetry 2.1.3 and should not be changed by hand."
 * Unknown -> 2 (the current release line).
 */
function detectPoetryMajor(lockText, setting) {
  if (setting === "1" || setting === 1) return 1;
  if (setting === "2" || setting === 2) return 2;
  const m = /@generated by Poetry (\d+)\./.exec(typeof lockText === "string" ? lockText.slice(0, 4000) : "");
  if (m) return parseInt(m[1], 10) >= 2 ? 2 : 1;
  return 2;
}

// ---------------------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------------------

/**
 * Split a command string into argv without a shell: whitespace separates words, single quotes
 * are literal, double quotes allow \" and \\ escapes. Returns null for an empty or
 * unterminated string.
 */
function splitCommand(str) {
  if (typeof str !== "string") return null;
  const out = [];
  let cur = "";
  let has = false;
  let q = null;
  for (let i = 0; i < str.length; i++) {
    const c = str[i];
    if (q === "'") {
      if (c === "'") q = null;
      else cur += c;
    } else if (q === '"') {
      if (c === '"') q = null;
      else if (c === "\\" && (str[i + 1] === '"' || str[i + 1] === "\\")) cur += str[++i];
      else cur += c;
    } else if (c === "'" || c === '"') {
      q = c;
      has = true;
    } else if (/\s/.test(c)) {
      if (has) {
        out.push(cur);
        cur = "";
        has = false;
      }
    } else if (c === "\\" && i + 1 < str.length && !/\s/.test(str[i + 1]) && process.platform !== "win32") {
      cur += str[++i];
      has = true;
    } else {
      cur += c;
      has = true;
    }
  }
  if (q) return null;
  if (has) out.push(cur);
  return out.length ? out : null;
}

/** Normalize a user override (string or array) to argv, or null if unset/invalid. */
function normalizeOverride(v) {
  if (Array.isArray(v)) {
    if (!v.length || !v.every((x) => typeof x === "string") || !v[0].trim()) return null;
    return v.slice();
  }
  if (typeof v === "string" && v.trim()) return splitCommand(v.trim());
  return null;
}

/** Quote an argv for display in the confirmation dialog and task label. */
function formatCommand(argv) {
  return argv
    .map((a) => (a === "" ? "''" : /^[A-Za-z0-9_@%+=:,./-]+$/.test(a) ? a : "'" + a.replace(/'/g, "'\\''") + "'"))
    .join(" ");
}

/**
 * Resolve the command for an ecosystem.
 * @param {string} ecosystem
 * @param {{overrides?: object, yarnFlavor?: string, poetryMajor?: number}} o
 * @returns {{argv: string[], variant: string, overridden: boolean}}
 */
function resolveCommand(ecosystem, o) {
  const opts = o || {};
  let variant = ecosystem;
  if (ecosystem === "yarn") variant = opts.yarnFlavor === "berry" ? "yarnBerry" : "yarn";
  if (ecosystem === "poetry") variant = opts.poetryMajor === 1 ? "poetry1" : "poetry2";
  const overrides = opts.overrides || {};
  // Berry can be overridden separately; otherwise the plain yarn override applies to both.
  const ov = normalizeOverride(overrides[variant]) || (variant === "yarnBerry" ? normalizeOverride(overrides.yarn) : null) || normalizeOverride(overrides[ecosystem]);
  if (ov) return { argv: ov, variant, overridden: true };
  return { argv: DEFAULT_COMMANDS[variant].slice(), variant, overridden: false };
}

/** Lockfile base for an ecosystem: "keep" | "ours" | "theirs". */
function resolveBase(ecosystem, overrides) {
  const v = overrides && overrides[ecosystem];
  if (v === "keep" || v === "ours" || v === "theirs") return v;
  return DEFAULT_BASE[ecosystem] || "ours";
}

// ---------------------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------------------

/** True if `child` equals `parent` or is inside it (both already absolute and resolved). */
function isInside(parent, child) {
  if (!parent || !child) return false;
  const rel = path.relative(parent, child);
  return rel === "" || (!!rel && !rel.startsWith("..") && !path.isAbsolute(rel));
}

/**
 * Resolve a path with realpath and return it only if it is inside one of the (realpath'd)
 * roots. Returns null when missing, outside, or unreadable.
 */
async function confine(p, realRoots) {
  let real;
  try {
    real = await fs.promises.realpath(p);
  } catch (_) {
    return null;
  }
  return realRoots.some((r) => isInside(r, real)) ? real : null;
}

// ---------------------------------------------------------------------------------------
// Hardened git runner
// ---------------------------------------------------------------------------------------

function hardenedGitEnv() {
  const env = Object.assign({}, process.env, {
    GIT_CONFIG_GLOBAL: NULL_DEVICE,
    GIT_CONFIG_SYSTEM: NULL_DEVICE,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_OPTIONAL_LOCKS: "0",
    GIT_LITERAL_PATHSPECS: "1",
    GIT_TERMINAL_PROMPT: "0",
    GIT_ATTR_NOSYSTEM: "1",
    LC_ALL: "C",
  });
  for (const k of [
    "GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_EXTERNAL_DIFF", "GIT_PAGER", "PAGER",
    "GIT_OBJECT_DIRECTORY", "GIT_ALTERNATE_OBJECT_DIRECTORIES", "GIT_NAMESPACE",
    "GIT_COMMON_DIR", "GIT_CONFIG", "GIT_CONFIG_PARAMETERS", "GIT_CONFIG_COUNT", "GIT_CEILING_DIRECTORIES",
  ]) {
    delete env[k];
  }
  return env;
}

// core.fsmonitor= (empty) disables a repo-configured fsmonitor program; core.hooksPath at the
// null device means no hook (post-checkout etc.) can run.
const GIT_LEADING_ARGS = ["-c", "core.fsmonitor=", "-c", "core.hooksPath=" + NULL_DEVICE, "-c", "core.quotePath=false", "--no-pager"];

/**
 * Run git. Never throws; resolves { ok, code, stdout, stderr }.
 * @param {string} cwd
 * @param {string[]} args
 * @param {{gitPath?: string, timeout?: number}} [o]
 */
function runGit(cwd, args, o) {
  const opts = o || {};
  return new Promise((resolve) => {
    try {
      execFile(
        opts.gitPath || "git",
        GIT_LEADING_ARGS.concat(args),
        { cwd, env: hardenedGitEnv(), timeout: opts.timeout || 20000, maxBuffer: 1024 * 1024, windowsHide: true, shell: false },
        (err, stdout, stderr) => {
          resolve({ ok: !err, code: err ? (typeof err.code === "number" ? err.code : -1) : 0, stdout: String(stdout || ""), stderr: String(stderr || "").slice(0, 4000) });
        }
      );
    } catch (e) {
      resolve({ ok: false, code: -1, stdout: "", stderr: String(e) });
    }
  });
}

/**
 * Locate the repository for a lockfile and check it is safe to touch with git:
 * - the work tree top level (realpath) must contain the lockfile (a hostile core.worktree
 *   pointing elsewhere is refused);
 * - the lockfile must have no filter attribute (a clean/smudge filter would run a program).
 * @returns {Promise<{ok: true, top: string, rel: string} | {ok: false, reason: string}>}
 */
async function gitContext(realLockPath, o) {
  const dir = path.dirname(realLockPath);
  const r = await runGit(dir, ["rev-parse", "--show-toplevel"], o);
  if (!r.ok) return { ok: false, reason: "not-a-repo" };
  let top;
  try {
    top = await fs.promises.realpath(r.stdout.trim());
  } catch (_) {
    return { ok: false, reason: "not-a-repo" };
  }
  if (!isInside(top, realLockPath)) return { ok: false, reason: "outside-worktree" };
  const rel = path.relative(top, realLockPath).split(path.sep).join("/");
  const a = await runGit(top, ["check-attr", "filter", "--", rel], o);
  if (!a.ok) return { ok: false, reason: "check-attr-failed" };
  const m = /: filter: (.*)$/m.exec(a.stdout);
  const val = m ? m[1].trim() : "unspecified";
  if (val !== "unspecified" && val !== "unset") return { ok: false, reason: "filter-attribute" };
  return { ok: true, top, rel };
}

/**
 * Paths (repo-relative) that are unmerged in the index. Uses `git ls-files -u`, which reads
 * only the index (a `git diff` would refresh the index and could run clean filters).
 */
async function unmergedPaths(top, o) {
  const r = await runGit(top, ["ls-files", "-u", "-z"], o);
  if (!r.ok) return [];
  const out = new Set();
  for (const rec of r.stdout.split("\0")) {
    const tab = rec.indexOf("\t");
    if (tab > 0) out.add(rec.slice(tab + 1));
  }
  return Array.from(out);
}

/** `git checkout --ours|--theirs -- <rel>` */
function checkoutSide(ctx, side, o) {
  return runGit(ctx.top, ["checkout", side === "theirs" ? "--theirs" : "--ours", "--", ctx.rel], o);
}

/** `git add -- <rel>` */
function stage(ctx, o) {
  return runGit(ctx.top, ["add", "--", ctx.rel], o);
}

// ---------------------------------------------------------------------------------------
// Plan
// ---------------------------------------------------------------------------------------

const BASE_TEXT = {
  keep: "keep the conflict markers - the tool merges both sides itself",
  ours: "start from your side; during a rebase \"ours\" is the branch you are rebasing onto",
  theirs: "start from the incoming side; during a rebase \"theirs\" is your own commit",
};

/**
 * Warning shown with an ours/theirs base: the dropped side's lockfile-only pins are lost and
 * re-resolved from the manifest, so the result can differ from what that side had locked.
 * @param {"ours"|"theirs"} base
 * @param {string} lockName
 * @param {string} manifest
 */
function baseWarning(base, lockName, manifest) {
  const dropped = base === "theirs" ? "Your side's" : "The other branch's";
  const m = manifest || "the manifest";
  return (
    dropped + " " + lockName + " changes are dropped and re-resolved from " + m + ". " +
    "Versions that side pinned only in " + lockName + " (not in " + m + ") may change. " +
    "Review the lockfile diff before you commit."
  );
}

/**
 * Build the human-readable plan shown in the confirmation dialog.
 * @param {{lockName: string, relDir: string, base: string, argv: string[], manifest?: string}} p
 */
function describePlan(p) {
  const steps = [];
  const sided = p.base === "ours" || p.base === "theirs";
  if (sided) {
    steps.push("git checkout --" + p.base + " -- " + p.lockName + "   (" + BASE_TEXT[p.base] + ")");
  } else {
    steps.push("Keep " + p.lockName + " as it is (" + BASE_TEXT.keep + ")");
  }
  steps.push(formatCommand(p.argv));
  return (
    "Folder: " + (p.relDir || ".") + "\n\n" +
    steps.map((s, i) => (i + 1) + ". " + s).join("\n") +
    (sided ? "\n\n" + baseWarning(p.base, p.lockName, p.manifest) : "") +
    "\n\nThe command runs in a visible terminal task. Nothing is staged until you choose to."
  );
}

module.exports = {
  NULL_DEVICE,
  LOCKFILES,
  LOCKFILE_NAMES,
  ECOSYSTEMS,
  EXCLUDED_DIRS,
  DEFAULT_COMMANDS,
  DEFAULT_BASE,
  lockfileInfo,
  findConflictBlocks,
  hasConflictMarkers,
  oursSide,
  detectYarnFlavor,
  detectPoetryMajor,
  splitCommand,
  normalizeOverride,
  formatCommand,
  resolveCommand,
  resolveBase,
  isInside,
  confine,
  hardenedGitEnv,
  GIT_LEADING_ARGS,
  runGit,
  gitContext,
  unmergedPaths,
  checkoutSide,
  stage,
  describePlan,
  baseWarning,
};
