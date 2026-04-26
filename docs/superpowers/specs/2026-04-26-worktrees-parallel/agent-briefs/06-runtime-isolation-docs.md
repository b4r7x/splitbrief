# 06 — Runtime Isolation Documentation

> Fresh AI context brief. Implement only this change. Never stage or commit.

## Goal

Produce clear, frank user-facing documentation explaining what git worktrees DO and DO NOT isolate, and what the user can do about the gaps. This is a documentation-only brief — zero source code changes.

## Read First

- `CLAUDE.md`
- `docs/WORKFLOW.md` — existing workflow docs style and structure
- `docs/CONFIG.md` — how configuration docs are organized
- The `decisions.md` in this spec, especially ADR-007 and ADR-001.
- The `README.md` in this spec for the overall feature scope.

## Files To Touch

- `docs/WORKTREES.md` — new file (primary output)
- `docs/WORKFLOW.md` — add a short "Parallel Worktrees" section linking to `WORKTREES.md`

Do not touch any source code, schemas, or test files.

## Content Contract for `docs/WORKTREES.md`

The document must cover the following sections in order.

### 1. What worktrees give you

- Filesystem isolation: each worktree is a separate directory with its own working tree. Files edited in `.trees/my-feature` do not affect the main tree.
- Branch isolation: each worktree checks out its own branch. Implementer commits go to that branch, not to `main`.
- Diptych state isolation: each worktree has its own `.diptych/` directory, its own `.diptych/active` lockfile, and its own session history. Running two diptych sessions in two worktrees is safe.
- Snapshot isolation (when snapshots-undo is also installed): each worktree's snapshots are stored under its own `.diptych/sessions/`.

### 2. What worktrees do NOT give you (the isolation gap)

State this loudly. The heading should be: **What worktrees do NOT isolate**.

Cover each gap with a concrete failure scenario:

| Gap | Failure scenario |
|---|---|
| Dev server ports | `npm run dev` in both worktrees defaults to port 3000 — one will fail or shadow the other. |
| `node_modules` | In many setups `node_modules` is shared (npm/yarn hoist to workspace root). Installing a package in one worktree may break the other if versions conflict. |
| Environment variables | Shell env vars set in one terminal session bleed into any process started from that session. `.env` files read at runtime are per-directory but only if the framework reloads them. |
| Database / file-system state | If both worktrees connect to the same local database or write to the same output directory, they will conflict. |
| Lock files | Tools like `@prisma/client` generate or cache files in shared locations. Two simultaneous generates will race. |

### 3. Recommended mitigations

Each mitigation must be actionable with a concrete example or command:

**Port management (simplest):**
Set `PORT` or equivalent env var per worktree before starting the dev server. Example:

```bash
PORT=3001 npm run dev   # in .trees/my-feature
PORT=3000 npm run dev   # in main tree
```

**`direnv` for per-worktree environment:**
Create a `.envrc` in each worktree with the overrides. `direnv` applies it automatically when you `cd` into the directory. Example `.envrc`:

```bash
export PORT=3001
export DATABASE_URL=postgresql://localhost/myapp_feature
```

**Separate databases per worktree:**
Use a dedicated database or schema name per worktree. Most local Postgres/SQLite setups allow this. Name the database after the feature: `myapp_my_feature`.

**Docker Compose per worktree (intermediate):**
Each worktree gets its own `docker-compose.override.yml` with unique port mappings and volume names. Run `docker compose up` separately per worktree.

**devcontainer per worktree (full isolation):**
VS Code devcontainers can be configured per directory. Open each worktree as a separate VS Code window; each window spins up its own container with full port and filesystem isolation. See [VS Code Dev Containers documentation](https://code.visualstudio.com/docs/devcontainers/containers) for per-folder configuration.

**microVM (advanced):**
Tools like Firecracker or Lima allow creating lightweight VMs per worktree. Full process, port, and filesystem isolation. Out of scope for this release but a natural next step for CI-style parallel runs.

### 4. `.gitignore` advice

Add `.trees/` to the project `.gitignore` to prevent git from showing worktree directories in `git status` for the main tree:

```
# diptych worktrees
.trees/
```

Diptych does not write this automatically. Run the above once after your first `diptych start --worktree`.

### 5. Quick-start checklist

A numbered list the user can follow verbatim to run two sessions safely:

1. Add `.trees/` to `.gitignore`.
2. Pick distinct ports for each worktree's dev server (or use `direnv`).
3. Use a separate database or schema per worktree if your project uses a local database.
4. Open each worktree in a separate terminal window or VS Code window.
5. Run `diptych start --worktree <name> "<feature>"` in each window.
6. Use `diptych worktree list` from the main tree to see all sessions.
7. When done, merge the branch you prefer and run `diptych worktree remove <name> --delete-branch`.

## Content Contract for `docs/WORKFLOW.md` addition

Add a short section titled "Parallel Worktrees" near the end of `WORKFLOW.md` (before any "See also" or footer):

```markdown
## Parallel Worktrees

Run multiple diptych sessions simultaneously using git worktrees:

```bash
diptych start --worktree feature-a "add user auth"
diptych start --worktree feature-b "refactor billing"
diptych worktree list
```

Each worktree is fully isolated at the filesystem and diptych-state level. Runtime isolation (ports, environment) is the user's responsibility. See [docs/WORKTREES.md](./WORKTREES.md) for the complete guide including the isolation gap and mitigations.
```

## Style Rules

- Use the same heading style as `docs/WORKFLOW.md` (ATX headings, no setext).
- Write for a developer audience — no fluff, no marketing language.
- Each failure scenario must be a concrete action + concrete failure, not an abstract possibility.
- Do not invent command syntax that does not exist in this spec.
- No emojis.

## Acceptance Criteria

- `docs/WORKTREES.md` exists and covers all five sections above.
- The isolation gap section leads with a clear "this is what worktrees do NOT solve" statement.
- All mitigation examples are syntactically correct shell or config.
- `docs/WORKFLOW.md` has the short "Parallel Worktrees" section linking to `WORKTREES.md`.
- No source code was modified.

## Verification Commands

```bash
# Confirm no source files were modified
git diff --name-only src/
# Should output nothing.

# Confirm new and modified docs exist
ls docs/WORKTREES.md
grep -n "Parallel Worktrees" docs/WORKFLOW.md
```
