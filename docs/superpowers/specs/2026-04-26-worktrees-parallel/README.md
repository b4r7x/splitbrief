# Worktrees & Parallel Sessions — 2026-04-26

> **Status:** draft spec (v2).
> **Scope:** git worktree lifecycle (create / list / switch / remove), per-worktree isolation, TUI disambiguation, and a plain-docs brief on the runtime isolation gap. `--parallel N` fan-out is deferred to v3.
> **Supersedes (partial):** `docs/superpowers/specs/2026-04-22-safe-snapshots-worktrees-parallel/` combined snapshots + worktrees into one draft. This spec is the split v2 covering worktrees only. The split v1 (snapshots) is `docs/superpowers/specs/2026-04-26-snapshots-undo/`.
> **Out of scope:** `--parallel N` fan-out (deferred to v3); devcontainer / microVM integration; port conflict management; runtime process isolation.

## Purpose

Multiple diptych sessions can run concurrently in isolated git worktrees — each with its own branch, its own `.diptych/` state directory, and its own session history.

Primary use cases:

- Try the same brief with two different implementer model configs in parallel; pick the better diff.
- Run several unrelated features simultaneously without file-lock conflicts.
- Keep a long-running planner exploration in one worktree while making quick edits in another.

The core invariant: **each worktree has its own `.diptych/active` lockfile, so sessions cannot conflict at the diptych level regardless of how many worktrees are open.**

## Reading Order

| Step | File | Purpose |
|---|---|---|
| 1 | `README.md` | Human overview — this file. |
| 2 | `decisions.md` | Architecture and product decisions (ADRs). |
| 3 | `agent-briefs/00-coordinator.md` | Execution order and shared invariants. |
| 4 | `agent-briefs/01-worktree-manager.md` | Engine-side worktree create / list / remove helpers. |
| 5 | `agent-briefs/02-cli-start-worktree-flag.md` | Extend `diptych start` with `--worktree [name]`. |
| 6 | `agent-briefs/03-cli-worktree-commands.md` | `diptych worktree list / switch / remove` subcommands. |
| 7 | `agent-briefs/04-tui-worktree-indicator.md` | Header label showing worktree name when not in main tree. |
| 8 | `agent-briefs/06-runtime-isolation-docs.md` | Documentation explaining the runtime isolation gap. |

Brief `05-parallel-fan-out.md` is intentionally absent. Fan-out via `--parallel N` is deferred to v3 (see ADR-004).

## Change Set

| # | Brief | Goal |
|---|---|---|
| 01 | Worktree Manager | Engine helpers: `createWorktree`, `listWorktrees`, `removeWorktree`, `detectWorktree`. |
| 02 | CLI — start `--worktree` | Add `--worktree [name]` to `diptych start`, create worktree automatically. |
| 03 | CLI — worktree commands | `diptych worktree list / switch / remove` subcommands. |
| 04 | TUI Worktree Indicator | Header label when running inside a diptych-managed linked worktree. |
| 06 | Runtime Isolation Docs | User-facing docs: filesystem vs runtime isolation gap, suggested mitigations. |

## Key Files Introduced

```text
src/engine/git/worktree.ts            — createWorktree / listWorktrees / removeWorktree / detectWorktree
src/engine/git/worktree.test.ts
src/cli/commands/worktree.ts          — diptych worktree list/switch/remove
src/cli/commands/worktree.test.ts
docs/WORKTREES.md                     — runtime isolation gap + user guide
```

## Key Files Modified

```text
src/core/paths.ts                     — TREES_DIR constant + worktreePath helper
src/core/types/config-options.ts      — WorkflowOpts gains worktree?: string
src/cli/commands/start.ts             — --worktree [name] flag
src/cli/options.ts                    — addWorkflowOptions includes --worktree
src/cli.ts                            — register worktree command
src/features/workflow/components/header.tsx — worktree label when not in main tree
docs/WORKFLOW.md                      — worktree usage section
docs/CONFIG.md                        — any new config keys
```

## Dependencies

| Prerequisite | Status |
|---|---|
| `simple-git` in deps | Existing — already used in codebase |
| `.diptych/active` lockfile per working tree | Existing — `src/core/sessions/lifecycle.ts` |
| Session directory at `.diptych/sessions/<id>/` | Existing — `src/core/paths.ts` |
| Snapshot system from snapshots-undo | Recommended companion — each worktree gets its own snapshot history automatically; no hard dependency |

## Done Criteria

- `diptych start --worktree` creates a linked worktree at `.trees/<slug>`, checks out a new branch `diptych/<slug>`, and starts a session inside it.
- `diptych worktree list` shows all diptych-managed worktrees with branch name and session status (active / idle / none).
- `diptych worktree switch <name>` prints or executes a shell `cd` to the worktree root.
- `diptych worktree remove <name>` removes the worktree and branch (prompts on uncommitted changes or live session; `--force` skips prompt).
- TUI header shows the worktree name (branch slug) when running inside a linked worktree.
- `.trees/` is added to project `.gitignore` advice (documented; not auto-written).
- All engine code is free of React / Ink / features imports.
- `npm run test-ci` passes.

## Quality Bar For Implementing Agents

- Worktree creation must fail clearly if the branch already exists, with a hint to reuse or choose a different name.
- `removeWorktree` must refuse if `.diptych/active` exists in the target worktree and the session is live, unless `--force` is passed.
- `removeWorktree` must refuse if the target worktree has uncommitted changes, unless `--force` is passed.
- `--force` must log each bypassed guard explicitly so the user knows what was skipped.
- `detectWorktree` uses `git rev-parse` to distinguish a linked worktree from the main checkout.
- Path constants go in `src/core/paths.ts`; do not hardcode `.trees` in engine code.
- No new runtime dependencies beyond `simple-git` (already present).
- No git staging or committing anywhere in this spec.

## Shared Context For Agents

- Project: `diptych`, Node 22+, TypeScript, ESM-only, `.js` import extensions.
- UI: Ink 6 + React 19.
- Tests: Vitest 4, colocated.
- Zero classes, zero barrels, kebab-case file names.
- Engine code must not import from `react`, `ink`, `src/features/`, or `src/components/`.
- Never run `git add`, `git stage`, or `git commit`.
