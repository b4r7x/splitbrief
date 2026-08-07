# SPLITBRIEF — Worktrees

A git worktree is a second checkout of one repository: its own directory, its own branch, sharing a single object store. SPLITBRIEF uses worktrees for two different jobs:

- **Run isolation** — a run whose implementer writes files itself works in a worktree instead of your checkout, and its changes are promoted into your project once they are approved.
- **Parallel sessions** — two sessions in two worktrees do not collide, because each worktree carries its own `.splitbrief/`.

This document covers both, what a worktree does not isolate, and how to close the gaps.

## Run isolation

When the configured implementer writes files itself (`writesFiles: direct` — the `cli`, `agent`, and `agent-sdk` kinds), it does not edit your checkout. It works in an isolated directory, and a git worktree is the default choice for that directory. You can select a different isolation strategy; the worktree is the default, not the only option.

**One worktree per run, not one per task.** The isolation directory is created once when the run starts, and every task in the run works in it. Tasks execute sequentially, so a later task sees what earlier ones did — the same thing it would see in your checkout.

**Project dependencies are reachable inside it.** Dependencies are made available in the worktree so the implementer can run the project's own typecheck, lint, and tests against its own work. An isolated directory where nothing runs is worth less than no isolation at all: the agent cannot check itself, and every mistake travels to the validation step instead of dying where it was made.

**Changes are promoted into your project.** Isolation is where the work happens, not where it ends. After each task, the changed set is computed against a baseline captured when that task acquired the workspace — not when the directory was first created — put through the approval gate, and written into your real project directory. Promotion is hash-guarded: if a file changed underneath SPLITBRIEF between the approval read and the write, it is not overwritten — the whole promotion is refused and reported as a conflict. Validation then runs in your project, on the promoted result.

The implementer being able to run checks on its own work improves first-pass rate. It is not what decides correctness: SPLITBRIEF's own validation pipeline and the planner's review are.

## What worktrees give you

- **Filesystem isolation.** Each worktree is a separate directory. Files edited in `.trees/my-feature` do not affect the main tree and vice versa.
- **Branch isolation.** Each worktree checks out its own branch. When the session itself runs in a worktree, SPLITBRIEF's per-task commits go to that branch, not to `main`.
- **SPLITBRIEF state isolation.** Each worktree has its own `.splitbrief/` directory, its own `.splitbrief/active` pointer, and its own session history. Running two SPLITBRIEF sessions in two worktrees is safe because the session state lives inside each worktree.
- **Snapshot isolation.** Each worktree's snapshots and run accept/reject ledger are stored under its own `.splitbrief/sessions/`. Snapshots from one session do not appear in another.
- **Credential isolation.** A runner working in the worktree gets a private HOME under `.splitbrief/sandbox` — every runner but one, and that exception (Claude Code `session` on macOS) is named below — and a session-authenticated CLI reads a read-only snapshot of its own state there instead of your real credential file. Each role gets its own root — `.splitbrief/sandbox/planner` and `.splitbrief/sandbox/implementer` — and an acquisition clears and re-bridges only inside the root its own role reads. A planner escalating into the same worktree therefore cannot strand the implementer's credentials, and its HOME is never where the implementer's snapshot lands, whichever role acquires first. That matters because both flagship CLIs ship a `session` channel and an `api-key` channel: a `codex` planner on one and a `codex` implementer on the other is an ordinary configuration, and separate roots are what make it safe. Within a role the sandbox is still shared, and there a CLI runner refreshes only its own tool's snapshot while a runner with no CLI identity of its own — an `api` or `agent-sdk` runner — refreshes none, so two implementer profiles on different tools leave each other alone. The one case a role's root cannot serve is two implementer profiles naming the *same* tool on different auth channels: they share one destination, and the `api-key` profile clears it without bridging anything back, leaving the `session` profile pointed at a HOME whose snapshot has been removed. Give those profiles different tools, or the same channel, if that matters to you. Every snapshot is dropped when the run's isolation is disposed — teardown sweeps every root.

### The one exception: Claude Code `session` on macOS

Claude Code keeps its subscription session in the macOS login keychain rather than in a file. The keychain's default search list resolves through `HOME` and the item is keyed on the account name in `USER`, so a sandbox HOME severs it — measured with `claude auth status`, a child given a sandbox HOME reports `"loggedIn": false` whatever the host holds, and so does a child given the real `HOME` without `USER`. There is no file to copy, so **that one channel keeps your real `HOME` and `USER`** and bridges nothing.

That is a deliberate trade, and it was made against a worse one. The only other way to make a macOS `claude` child usable is to steer it onto `api-key` and meter it — charging per token for a subscription the user already pays for. Constitution Principle I forbids that: "Where the user already pays for a coding tool subscription, that subscription MUST be usable as the planner — planning MUST NOT require a separate API key." Keeping the host `HOME` on one channel is the cost of honouring it.

Which runners keep a private HOME, and which do not:

| Runner | HOME | Host state it reads |
|---|---|---|
| Claude Code, `session` channel, **macOS** | your real `HOME`, plus real `USER` | the login keychain, through its default search list |
| Claude Code, `session` channel, Linux / Windows | private, under `.splitbrief/sandbox/<role>/home` | a read-only copy of `~/.claude/.credentials.json` |
| Codex and Copilot, `session` channel, every platform | private | a read-only copy of that tool's own credential file |
| OpenCode and Kilo Code, `provider-dependent` channel | private | a read-only copy of that tool's own credential file |
| Any runner on an `api-key` channel | private | none — the credential arrives as an environment variable |
| Aider, and every `api`, `shell`, `agent`, or `agent-sdk` runner | private | none |

The discriminant is in the catalog, not in a platform check scattered through the engine: a channel declares `hostKeychainPlatforms` (`src/core/runners/cli-tool-catalog.ts`), and only the Claude Code `session` channel declares one — `['darwin']`. `cliAuthChannelHostStateAccess()` maps that to `host-account`; everything else is `bridged-files` or `none`.

What the `host-account` child gains:

- `~`-relative resolution lands in your real home, so a tool reading its own defaults there — `~/.ssh/config`, `~/.aws/credentials`, `~/.npmrc`, `~/.gitconfig` — finds the real file instead of an empty sandbox.
- The login keychain becomes reachable through its **default** search list, so `security find-generic-password …` with no keychain argument now returns your items. That is the point of the change; it is also its cost.
- Claude Code writes its own state to your real home (`~/.claude.json`, history, project permissions), exactly as it does when you run `claude` yourself — the sandbox no longer absorbs those writes.

And what it does **not** gain, so the accounting is not overstated:

- Nothing beyond `HOME`, `USERPROFILE` and `USER` is handed back. `TMPDIR`, `XDG_CONFIG_HOME`, `XDG_DATA_HOME`, `XDG_CACHE_HOME`, `APPDATA`, `LOCALAPPDATA`, `npm_config_cache`, `PIP_CACHE_DIR` and `CARGO_HOME` still point inside `<project>/.splitbrief/sandbox/`, and the environment allowlist still strips every credential variable it strips today.
- No new *filesystem* reach. The sandbox has always been env redirection, not confinement (see "What worktrees do NOT isolate"): a child in a sandbox HOME could already read `/Users/you/.ssh/` by absolute path, and could already open the login keychain by naming `~/Library/Keychains/login.keychain-db` explicitly. What changes is which paths the child finds *by default*, not which paths it is permitted to open.
- No credential is copied anywhere. The session token stays in the keychain; nothing is written to disk, so nothing can outlive the run or be committed by accident.

One consequence of never holding the token: the parent-side redactor that strips a *bridged* credential value out of runner output has no value to strip on this channel, because SPLITBRIEF never learns one. Pattern-based secret redaction still applies to everything a runner emits.

If that trade is not one you want, set `authChannel: api-key` for the runner and export `ANTHROPIC_API_KEY`. That channel is metered, keeps the private HOME, and hands the child no host state.

## What worktrees do NOT isolate

**A worktree is not a security boundary.** It shares the object store, the refs, and `.git/config` with the real repository, and git hooks resolve to the same files — a hook installed in the repository fires for commits made in the worktree. A process running there reaches the whole repository and everything else the user can reach. Worktree isolation exists to keep unreviewed edits out of your working tree, not to contain a runner. A runner you would not run in your checkout is a runner you should not run in a worktree either.

Worktrees also do not isolate runtime state. The gaps below are silent — git reports no conflict, but your processes interfere at runtime.

| Gap | Failure scenario |
|---|---|
| Dev server ports | `npm run dev` in both worktrees defaults to port 3000 — one will fail or shadow the other. |
| `node_modules` | A fresh worktree has none. A run-isolation worktree gets the project's dependencies made reachable rather than reinstalled, so installing or upgrading a package from inside it changes them for the source checkout too. In a worktree you populate yourself, npm/yarn hoisting to a workspace root has the same effect between trees. |
| Environment variables | Shell env vars set in one terminal session bleed into any process started from that session. `.env` files are per-directory but only re-read if the framework reloads them on startup. |
| Database / file-system state | Both worktrees connecting to the same local database or writing to the same output directory will conflict. |
| Lock files | Tools like `@prisma/client` generate or cache files in shared locations. Two simultaneous generates will race. |

## Recommended mitigations

### Port management (simplest)

Set `PORT` (or the equivalent env var for your framework) per worktree before starting the dev server:

```bash
PORT=3001 npm run dev   # in .trees/my-feature
PORT=3000 npm run dev   # in main tree
```

### direnv for per-worktree environment

Create a `.envrc` in each worktree with the overrides. `direnv` applies it automatically when you `cd` into the directory:

```bash
export PORT=3001
export DATABASE_URL=postgresql://localhost/myapp_my_feature
```

Install direnv once (`brew install direnv` / `apt install direnv`), then run `direnv allow` inside each worktree.

### Separate databases per worktree

Use a dedicated database or schema name per worktree. Name it after the feature:

```bash
createdb myapp_my_feature
# set DATABASE_URL=postgresql://localhost/myapp_my_feature in .envrc
```

Most local Postgres and SQLite setups allow creating additional databases at zero cost.

### Docker Compose per worktree (intermediate)

Add a `docker-compose.override.yml` in each worktree with unique port mappings and volume names, then run `docker compose up` separately per worktree:

```yaml
# .trees/my-feature/docker-compose.override.yml
services:
  db:
    ports:
      - "5433:5432"
    volumes:
      - my_feature_pgdata:/var/lib/postgresql/data
volumes:
  my_feature_pgdata:
```

### devcontainer per worktree (full isolation)

VS Code devcontainers can be configured per directory. Open each worktree as a separate VS Code window — each window spins up its own container with full port and filesystem isolation. See the [VS Code Dev Containers documentation](https://code.visualstudio.com/docs/devcontainers/containers) for per-folder configuration.

### microVM (advanced)

Tools like Firecracker or Lima allow creating lightweight VMs per worktree, providing full process, port, and filesystem isolation. This is out of scope for a typical local workflow but is a natural fit for CI-style parallel runs.

## .gitignore advice

Add `.trees/` to the project `.gitignore` to prevent the main tree from showing worktree directories in `git status`:

```
# splitbrief worktrees
.trees/
```

SPLITBRIEF does not write this automatically, and a task cannot write it for you: isolation appends `.splitbrief/` and `.trees/` to the worktree's own `.gitignore`, and promotion strips those two entries from a promoted `.gitignore` unless your file already carried them — comparing against your file is the only way to tell your line from SPLITBRIEF's. A task told to add `.trees/` therefore reports success while that exact line never lands. Add it yourself. Every worktree SPLITBRIEF manages lives under `.trees/`, whether it created one for run isolation or you asked for one with `--worktree`, so make the addition once before your first run. The clean-tree requirement applies to `--worktree`, not to run isolation. `--worktree`
relocates the whole session, so the source working tree must be clean before SPLITBRIEF
creates or selects that worktree. Run isolation is seeded with your uncommitted work: without
seeding, promotion would overwrite your uncommitted edits with HEAD-derived content, and on
any working repository the default isolation would never engage at all. Gitignored files —
`.env` and friends — are never seeded, so a project whose tests need them cannot run its own
checks inside isolation. Under ADR-2 that costs first-pass rate, not correctness: SPLITBRIEF
validates in the real project directory after promotion either way.

## Command behavior

`--worktree` and run isolation are different things. Run isolation is where the implementer writes; it happens without a flag whenever the implementer writes files itself, and the run promotes into the project you started it from. `--worktree` relocates the whole session — its `.splitbrief/`, its state, its artifacts — so that worktree becomes the project the run promotes into.

`splitbrief start --worktree <name> "<feature>"` creates `.trees/<name>` on branch `splitbrief/<name>` and continues the workflow inside that worktree. Older docs described an earlier flow that only printed a follow-up `cd .trees/<name>; splitbrief start ...` command; current SPLITBRIEF does the directory selection for the run. `splitbrief start --detach --worktree <name> "<feature>"` applies the same ordering before spawning the detached server, so the server's project root is the worktree.

On creation, SPLITBRIEF copies the base checkout's `.splitbrief/config.yaml` and `.splitbrief/hooks/` into the new worktree so the run uses your configured runners and hooks rather than factory defaults. Everything else under `.splitbrief/` stays isolated: sessions, the `.splitbrief/active` pointer, snapshots, and the accept/reject ledger are created fresh per worktree and are never shared back to the base tree.

When the repo declares submodules (a `.gitmodules` file at the root), SPLITBRIEF runs `git submodule update --init --recursive` in the new worktree after `git worktree add`, because `git worktree add` alone leaves submodule directories empty. Submodules are populated so builds and tests inside the worktree see the same dependencies as the base checkout.

`splitbrief worktree list` prints `NAME`, `PATH`, `BRANCH`, `STATUS`, `SESSION`, `PHASE`, and `UPDATED`. Missing session data renders as `unknown`. `splitbrief worktree switch <name>` prints shell instructions because a child process cannot change your parent shell's current directory. `splitbrief worktree remove <name>` refuses live sessions and uncommitted changes unless `--force` is passed; forced removal warns with the live session id and uncommitted file count when known.

## Quick-start checklist

Follow these steps to run two SPLITBRIEF sessions in parallel safely:

1. Add `.trees/` to `.gitignore`.
2. Pick distinct ports for each worktree's dev server, or set up `direnv` with per-worktree `.envrc` files.
3. Use a separate database or schema per worktree if your project uses a local database.
4. Open each worktree in a separate terminal window or VS Code window.
5. Run `splitbrief start --worktree <name> "<feature>"` in each window.
6. Use `splitbrief worktree list` from the main tree to see all active sessions.
7. When done, merge the branch you prefer and run `splitbrief worktree remove <name> --delete-branch` to clean up.
