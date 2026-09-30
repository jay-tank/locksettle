# Changelog

## 0.1.0 - Initial release

- Detects lockfiles with real merge conflict blocks: `package-lock.json`, `npm-shrinkwrap.json`, `yarn.lock`, `pnpm-lock.yaml`, `poetry.lock`, `uv.lock`, `Cargo.lock`, `go.sum`, `composer.lock`, `Gemfile.lock`, `Pipfile.lock`, including monorepo subfolders. Markers inside strings or indented are ignored.
- Error on line 1 of the lockfile, one notification per conflict, and a status bar item while any lockfile is conflicted.
- Regenerate flow (CodeLens, Quick Fix, command): refuses while the manifest still has conflict markers and opens it; prepares the lockfile base (keep markers for npm / Yarn / pnpm, `git checkout --ours` for the rest); shows the exact command in a modal; runs it in a visible task in the lockfile's folder; verifies no markers remain and offers Stage lockfile.
- Built-in command table for npm, Yarn classic and berry, pnpm, Poetry 1 and 2, uv, Cargo, Go, Composer, Bundler and Pipenv, with `--ignore-scripts` / `--no-scripts` where supported. Every command and base can be overridden.
- Yarn berry detection (`packageManager`, `.yarnrc.yml`, lockfile format) and Poetry version detection (lockfile header).
- Activity bar view "Conflicted lockfiles": one row per conflicted lockfile labelled with its path, the ecosystem and "manifest conflicted" / "ready to regenerate", a badge with the count, inline Regenerate lockfile and Open manifest actions, a Rescan button, and empty states for nothing conflicted, turned off and untrusted workspaces.
- The confirmation for an `ours` / `theirs` base says that the other side's lockfile-only pins may change and that the diff should be reviewed; a failed tool run after the checkout says how to bring the conflict back (`git checkout -m`).
- Change detection: file watcher, rescan on save of a manifest or lockfile, and a 15 s polling fallback that runs only while the window is focused, stops on blur and dispose, and never re-reads unchanged files. Scans never overlap; a second regenerate of the same lockfile while one is running is refused.
- Commands: Regenerate lockfile, Show conflicted lockfiles, Rescan lockfiles, Open manifest.
- Security: nothing runs in an untrusted workspace; lockfiles are realpath-confined to the workspace and symlinks are ignored; hardened git (no shell, global/system config ignored, fsmonitor and hooks off, paths after `--`); lockfiles with a git filter attribute or an escaping `core.worktree` are refused. No network access, no telemetry.
