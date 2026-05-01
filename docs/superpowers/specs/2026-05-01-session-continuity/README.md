# Session Continuity - 2026-05-01

> **Status:** proposed
> **Scope:** unified session reconnection UX via `continue`, `last`, and numeric aliases.
> **Write scope for this pack:** source implementation plus `docs/superpowers/specs/2026-05-01-session-continuity/**`.
> **Out of scope:** deprecating `attach`/`resume`, detach changes, session cleanup/gc, multi-project session management.

## Problem

Diptych exposes 5 session commands (`ps`, `attach`, `detach`, `resume`, `start --detach`). Users must hold a mental model of session state to choose between `attach` (running) and `resume` (interrupted). They also need to copy long session IDs from `ps` output. This creates unnecessary friction for the dominant use case: "reconnect to what I was working on."

Users need ONE command that does the right thing regardless of session state, plus ergonomic shortcuts for common patterns.

## Scope

This pack specifies three connected UX improvements:

1. **`diptych continue [session-id]`** - Smart dispatch: attaches if the session is running (IPC alive), resumes if interrupted (state is resumable). One command replaces the need to distinguish between `attach` and `resume`.
2. **`diptych last`** - Shorthand for "continue the most recent session whatever its state." Finds the newest session by `lockfile.startTimeMs` and dispatches through `continue` logic.
3. **Numeric session aliases** - `ps` output gains a `#` column. Users can pass `1`, `2`, `3` instead of full session IDs to `continue` and `attach`.

## Baseline References

- `src/cli/commands/attach.ts`
- `src/cli/commands/resume.ts`
- `src/cli/commands/detach.ts`
- `src/cli/commands/ps.ts`
- `src/cli.ts` (command registration)
- `src/engine/ipc/lockfile.ts` (`checkServerStatus`, `readLockfile`)
- `src/core/sessions/lifecycle.ts` (`readActive`, `isSessionLive`)
- `src/core/sessions/io.ts` (`listSessions`, `listAllSessions`)
- `src/core/paths.ts` (`sessionsRoot`, `sessionDir`)
- `src/core/phases.ts` (`isResumable`, `RESUMABLE_PHASES`)
- `src/core/state/persistence.ts` (`loadState`)

## Reading Order

| Step | File | Purpose |
|---|---|---|
| 1 | `README.md` | Problem, scope, non-goals, and pack map. |
| 2 | `decisions.md` | ADR-style product and architecture decisions. |
| 3 | `execute-prompt.md` | Copy-paste prompt for handing this pack to an implementation context. |
| 4 | `agent-briefs/01-continue-command.md` | `diptych continue` worker brief. |
| 5 | `agent-briefs/02-last-command.md` | `diptych last` worker brief. |
| 6 | `agent-briefs/03-numeric-aliases.md` | Numeric aliases in `ps` + numeric arg resolution. |

## Implementation Order

1. **01-continue-command** ships first. Introduces `continueCommand` and a `resolveSessionInput` helper that initially handles only string session IDs.
2. **03-numeric-aliases** extends `resolveSessionInput` to accept numeric input, adds the `#` column to `ps` output, and adds numeric resolution to `attachCommand`.
3. **02-last-command** reuses `continueCommand` logic by finding the most recent session and passing it through.

This order respects data dependencies: `last` depends on `continue`'s dispatch logic, and `continue`'s final numeric-aware arg parsing depends on the alias resolver from brief 03.

## Non-Goals

- Do not deprecate `attach` or `resume`. They remain as low-level primitives.
- Do not change `detach` behavior or add numeric alias support to `detach`.
- Do not add session cleanup, garbage collection, or session limits.
- Do not build a session dashboard TUI.
- Do not persist numeric aliases to disk. They are derived at display time.
- Do not add background/foreground mode switching.
- Do not add multi-project session awareness.
