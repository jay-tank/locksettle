<h1 align="center">LockSettle</h1>

<p align="center"><b>Fix lockfile merge conflicts the right way: manifest first, then let the tool regenerate the lockfile.</b><br>
<code>package-lock.json</code>, <code>yarn.lock</code>, <code>pnpm-lock.yaml</code>, <code>poetry.lock</code>, <code>uv.lock</code>, <code>Cargo.lock</code>, <code>go.sum</code>, <code>composer.lock</code>, <code>Gemfile.lock</code>, <code>Pipfile.lock</code> - detected, explained and regenerated with the exact command for each ecosystem, in a task you can watch.</p>

## The problem

You rebase your branch on `main` and git stops:

```
CONFLICT (content): Merge conflict in package-lock.json
```

The lockfile now has `<<<<<<<`, `=======` and `>>>>>>>` blocks in the middle of a few
thousand lines of generated JSON. The tempting options are all wrong:

- **Hand-edit it.** You are guessing at resolved versions and integrity hashes.
- **"Accept Both Changes".** Produces duplicate keys and a lockfile that no longer matches
  either side.
- **Accept one side.** The file is valid again, but every dependency the other branch added
  or bumped is silently gone from the lock.

The correct routine is the same everywhere: resolve the **manifest** (`package.json`,
`pyproject.toml`, `Cargo.toml`, `go.mod` and friends) first, then let the package manager
regenerate the lockfile from it. npm, Yarn and pnpm can even merge a conflicted lockfile on
their own. The hard part is remembering the exact command for each tool at the moment you
are stuck in the middle of a rebase.

Further reading:

- npm docs: [Resolving lockfile conflicts](https://docs.npmjs.com/cli/v6/configuring-npm/package-locks) - fix `package.json`, then run `npm install --package-lock-only` again.
- pnpm docs: [Working with Git - Merge conflicts](https://pnpm.io/git) - pnpm merges a conflicted `pnpm-lock.yaml` itself.
- Composer docs: [Resolving merge conflicts](https://getcomposer.org/doc/articles/resolving-merge-conflicts.md) - why a text merge of a lockfile is not valid.

## What it does

- **Detects conflicted lockfiles** anywhere in your workspace, including monorepo
  subfolders, by looking for real conflict blocks (a `<<<<<<<` / `=======` / `>>>>>>>`
  sequence at the start of lines). Markers quoted inside strings or indented are ignored.
- **Warns you before you touch it**: an error on line 1 of the lockfile
  ("Don't edit it by hand - LockSettle can regenerate it"), one notification per conflict,
  and a status bar item while any lockfile is conflicted.
- **Activity bar**: a LockSettle view lists every conflicted lockfile by its path, with
  the ecosystem and its state ("manifest conflicted" or "ready to regenerate") next to it
  and a badge with the count. Click a row to open the lockfile at its first conflict; the
  inline **Regenerate lockfile** and **Open manifest** buttons start the flow or jump to the
  manifest's conflict. With nothing conflicted it explains what it watches and offers
  **Rescan**.
- **Regenerates it** from a CodeLens on line 1, the Quick Fix, the status bar or the
  command palette:
  1. Checks that the paired manifest (and any workspace member manifest below it) has no
     conflict markers. If it does, it opens that file at the conflict and stops.
  2. Prepares the lockfile base for the ecosystem (see the table): either keeps the markers
     for tools that merge them, or runs `git checkout --ours -- <lockfile>` so the tool
     starts from a valid file.
  3. Shows a **modal confirmation with the exact command** and folder, then runs it in a
     **visible VS Code task** in the lockfile's own folder. When the base is `ours` (or
     `theirs`), the modal says plainly that the other side's lockfile changes are dropped
     and re-resolved from the manifest, so versions it pinned only in the lockfile may
     change, and that you should review the diff before committing.
  4. When the task ends with exit code 0, checks that no markers are left and offers
     **Stage lockfile** (`git add -- <lockfile>`).

## The command table

| Lockfile | Manifest | Default base | Command LockSettle runs |
| --- | --- | --- | --- |
| `package-lock.json`, `npm-shrinkwrap.json` | `package.json` | keep markers | `npm install --package-lock-only --ignore-scripts` |
| `yarn.lock` (Yarn 1, classic) | `package.json` | keep markers | `yarn install --ignore-scripts` |
| `yarn.lock` (Yarn 2+, berry) | `package.json` | keep markers | `yarn install --mode=update-lockfile` |
| `pnpm-lock.yaml` | `package.json` | keep markers | `pnpm install --lockfile-only --ignore-scripts` |
| `poetry.lock` (Poetry 1.x) | `pyproject.toml` | ours | `poetry lock --no-update` |
| `poetry.lock` (Poetry 2.x) | `pyproject.toml` | ours | `poetry lock` |
| `uv.lock` | `pyproject.toml` | ours | `uv lock` |
| `Cargo.lock` | `Cargo.toml` | ours | `cargo update --workspace` |
| `go.sum` | `go.mod` | ours | `go mod tidy` |
| `composer.lock` | `composer.json` | ours | `composer update --lock --no-install --no-scripts` |
| `Gemfile.lock` | `Gemfile` | ours | `bundle lock` |
| `Pipfile.lock` | `Pipfile` | ours | `pipenv lock` |

Notes on the choices:

- **keep markers**: npm (5.7+), Yarn and pnpm read a conflicted lockfile, merge both sides
  and write a clean one, so both branches' dependencies survive. The other tools cannot
  parse conflict markers, so LockSettle starts them from your side (`--ours`) and they
  re-resolve it against the merged manifest. During a **rebase** git swaps the meaning:
  "ours" is the branch you are rebasing onto.
- **Yarn berry** is detected from the `packageManager` field (`yarn@2` or later), then a
  `.yarnrc.yml` in the folder or above it, then the lockfile format (`__metadata:`).
  `--mode=update-lockfile` updates the lockfile without linking, so no install scripts run.
  Yarn classic has no lockfile-only mode, so `yarn install` also refreshes `node_modules`.
- **Poetry 1 or 2** is read from the `@generated by Poetry X` header of `poetry.lock`.
  Poetry 2 removed `--no-update` because `poetry lock` no longer upgrades by default.
- **Cargo** uses `cargo update --workspace`, not `cargo generate-lockfile`: the latter
  re-resolves every dependency to the newest allowed version, which is far more churn than
  a merge needs. `--workspace` keeps locked versions and only fixes what the manifests
  changed.
- **Composer**: `update --lock` refreshes the lock against `composer.json` without
  upgrading everything; `--no-install` needs Composer 2.1 or later (override the command
  on older versions).
- **`--ignore-scripts` is a safety choice.** Regenerating a lockfile should not run
  lifecycle scripts from packages you have not reviewed yet, so the flag is added wherever
  the tool supports it (npm, Yarn classic, pnpm; `--no-scripts` for Composer).

Every command and every base can be changed in the settings.

### Which ecosystems were run for real

The conflict-and-regenerate flow was run end to end with the real tools on real merge
conflicts for **npm**, **Yarn classic (1.x)**, **pnpm** and **Cargo**: npm, Yarn and pnpm
merged the conflicted lockfile themselves and left no markers; Cargo refuses a file with
markers, which is why it starts from `--ours`. For **Yarn berry, Poetry, uv, Go, Composer,
Bundler and Pipenv** the commands come from each tool's documentation and are listed here
as a command table only; they have not been run end to end yet. If one misbehaves, override
it with `locksettle.commands.<ecosystem>`.

## Settings

| Setting | Default | Description |
| --- | --- | --- |
| `locksettle.enabled` | `true` | Watch the workspace for conflicted lockfiles. |
| `locksettle.notify` | `true` | One notification when a lockfile gets conflict markers. |
| `locksettle.codeLens` | `true` | Regenerate CodeLens on line 1 of a conflicted lockfile. |
| `locksettle.lockfileBase` | `{}` | Per-ecosystem base: `keep`, `ours` or `theirs`, for example `{"npm": "ours"}`. |
| `locksettle.yarnFlavor` | `auto` | `auto`, `classic` or `berry`. |
| `locksettle.poetryVersion` | `auto` | `auto`, `1` or `2`. |
| `locksettle.commands.npm` ... `locksettle.commands.pipenv` | `""` | Override the command for `npm`, `yarn`, `yarnBerry`, `pnpm`, `poetry`, `uv`, `cargo`, `go`, `composer`, `bundler`, `pipenv`. A string is split into words without a shell (quotes work, `;` and `&&` are just text); an array is used as is. Empty means the built-in command. |

## Commands

- **LockSettle: Regenerate lockfile** - for the active lockfile, or pick one.
- **LockSettle: Show conflicted lockfiles** - Quick Pick of every conflicted lockfile (also
  the status bar click); picking one starts the regenerate flow.
- **LockSettle: Rescan lockfiles** - scan the workspace again now.
- **LockSettle: Open manifest** - open the manifest paired with a conflicted lockfile, at
  its conflict when it has one (also an inline button in the view).

## Privacy and safety

- **No network, no telemetry.** LockSettle itself never connects anywhere. The package
  manager you confirm may of course contact its registry.
- **Nothing runs without your click and the confirmation dialog.** The command runs in a
  visible task, never in the background.
- **Workspace Trust.** In an untrusted workspace LockSettle only reads lockfiles and
  manifests to show the warnings. It runs no git command and no package manager until you
  trust the workspace.
- **Stays inside your workspace.** Only lockfiles whose real path is inside an open
  workspace folder are handled; a symlinked lockfile is ignored. The task runs in the
  lockfile's folder.
- **Hardened git.** `git checkout --ours` and `git add` run without a shell, with an
  argument list and the path after `--`; global and system git config are ignored;
  `core.fsmonitor` and hooks are turned off; output and run time are capped. LockSettle
  refuses to touch a lockfile that has a git `filter` attribute (it would run a program) or
  a repository whose `core.worktree` points somewhere that does not contain the file.

## Limitations

- LockSettle cannot resolve a conflicted **manifest** for you. That part needs a human
  decision; LockSettle opens the file and waits.
- The regenerate command needs the tool installed and usually registry access. If it
  fails, the task terminal shows why and nothing is staged.
- Regeneration re-resolves dependencies. For the "ours" ecosystems, versions the other
  branch pinned in its lockfile (but not in its manifest) may resolve differently. Review
  the diff before committing.
- `poetry lock` and `uv lock` may build source distributions to read their metadata, and
  `bundle lock` evaluates your `Gemfile` (Ruby code). Those tools have no flag to prevent it.
- Change detection uses a file watcher. Where watchers do not fire (some network or
  container file systems, an exhausted watcher limit), a light rescan runs every 15 seconds
  while the VS Code window is focused; it stops when the window loses focus and only
  re-reads files whose size or modification time changed. Saving a manifest or lockfile
  rescans at once, and **Rescan lockfiles** is always available.
- Conflicts are detected from markers in the file. A lockfile that git reports as
  conflicted without markers (for example "deleted by them") is not shown.
- Workspace-member manifests are checked below the lockfile's folder only; a Cargo or
  Go workspace member that lives elsewhere is not checked.

## License

MIT - included with the extension.
