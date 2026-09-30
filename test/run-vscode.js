"use strict";

// Launches a real, isolated VS Code window with LockSettle loaded from this folder and runs
// test/vscode/index.js inside it: once trusted (full suite), once untrusted (must stay idle).
// In the trusted run the test asks for a screenshot of the (hidden) display with the
// LockSettle view open; it is saved as <tmpBaseDir>/locksettle-panel.png.
// Usage: node test/run-vscode.js [tmpBaseDir]

const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn, execFileSync } = require("child_process");
const { makeMainRepo, makeHostileRepo, makeWorktreeEscapeRepo } = require("./fixtures");

const extDir = path.resolve(__dirname, "..");
const base = fs.realpathSync(fs.mkdtempSync(path.join(process.argv[2] || os.tmpdir(), "ls-vscode-")));

function buildWorkspace(tag) {
  const d = path.join(base, tag);
  const mainRoot = makeMainRepo(path.join(d, "ws", "main"));
  const outsideDir = path.join(d, "outside");
  const markerDir = path.join(d, "markers");
  const hostileRoot = makeHostileRepo(path.join(d, "ws", "hostile"), outsideDir, markerDir);
  const escRoot = makeWorktreeEscapeRepo(path.join(d, "ws", "esc"), path.join(d, "escaped-worktree"));
  const wsFile = path.join(d, "test.code-workspace");
  fs.writeFileSync(wsFile, JSON.stringify({ folders: [{ path: mainRoot }, { path: hostileRoot }, { path: escRoot }] }, null, 2));
  return { mainRoot, hostileRoot, escRoot, outsideDir, markerDir, wsFile };
}

const userDir = path.join(base, "user");
const extsDir = path.join(base, "exts");
fs.mkdirSync(path.join(userDir, "User"), { recursive: true });
fs.mkdirSync(extsDir, { recursive: true });
const settingsPath = path.join(userDir, "User", "settings.json");
const resultFile = path.join(base, "results.json");
const cfgFile = path.join(base, "config.json");
const shotDir = path.join(base, "shots");
fs.mkdirSync(shotDir);
const shot = path.join(process.argv[2] ? path.resolve(process.argv[2]) : base, "locksettle-panel.png");

function writeSettings(ws, trustEnabled) {
  fs.writeFileSync(
    settingsPath,
    JSON.stringify({
      "security.workspace.trust.enabled": trustEnabled,
      "security.workspace.trust.startupPrompt": "never",
      // The built-in Git extension would itself run the hostile repos' fsmonitor; keep it out
      // of those two repos so any marker file can only come from LockSettle.
      "git.ignoredRepositories": [ws.hostileRoot, ws.escRoot],
      "git.openRepositoryInParentFolders": "never",
      "git.autofetch": false,
      "extensions.autoUpdate": false,
      "telemetry.telemetryLevel": "off",
      "update.mode": "none",
      "workbench.startupEditor": "none",
    }, null, 2)
  );
}

async function launch(ws, mode, extraArgs) {
  fs.writeFileSync(cfgFile, JSON.stringify(Object.assign({ mode, resultFile, shotDir }, ws)));
  const args = [
    "--wait", "--new-window",
    "--user-data-dir", userDir,
    "--extensions-dir", extsDir,
    "--disable-extensions",
    ...extraArgs,
    "--skip-welcome", "--skip-release-notes",
    "--extensionDevelopmentPath=" + extDir,
    "--extensionTestsPath=" + path.join(__dirname, "vscode", "index.js"),
    ws.wsFile,
  ];
  console.log("code " + args.join(" "));
  const child = spawn("code", args, { stdio: "inherit", env: Object.assign({}, process.env, { LS_TEST_CONFIG: cfgFile }) });
  const exited = new Promise((resolve) => child.on("exit", (code) => resolve(code)));
  const killer = setTimeout(() => child.kill("SIGKILL"), 300000);
  const poll = setInterval(() => {
    const want = path.join(shotDir, "shot-" + mode);
    if (!fs.existsSync(want)) return;
    fs.unlinkSync(want);
    try {
      execFileSync("import", ["-window", "root", "-display", process.env.DISPLAY || ":99", shot]);
      console.log("screenshot: " + shot);
    } catch (e) {
      console.log("screenshot failed: " + e.message);
    }
    fs.writeFileSync(path.join(shotDir, "shot-done-" + mode), "1");
  }, 300);
  const status = await exited;
  clearTimeout(killer);
  clearInterval(poll);
  console.log("code exit status:", status);
  if (!fs.existsSync(resultFile)) {
    console.log("FAIL: no results written");
    return { passed: 0, failed: 1, results: [] };
  }
  const res = JSON.parse(fs.readFileSync(resultFile, "utf8"));
  fs.unlinkSync(resultFile);
  for (const t of res.results) console.log((t.ok ? "PASS " : "FAIL ") + t.name + (t.detail ? " :: " + t.detail : ""));
  return res;
}

(async () => {
  const ws1 = buildWorkspace("run1");
  writeSettings(ws1, false);
  const r1 = await launch(ws1, "trusted", ["--disable-workspace-trust"]);

  const ws2 = buildWorkspace("run2");
  writeSettings(ws2, true);
  const r2 = await launch(ws2, "untrusted", []);

  const passed = r1.passed + r2.passed;
  const failed = r1.failed + r2.failed;
  console.log(`\nin-editor tests: ${passed} passed, ${failed} failed (trusted run ${r1.passed}/${r1.passed + r1.failed}, untrusted run ${r2.passed}/${r2.passed + r2.failed})`);
  if (!failed) fs.rmSync(base, { recursive: true, force: true });
  process.exit(failed ? 1 : 0);
})();
