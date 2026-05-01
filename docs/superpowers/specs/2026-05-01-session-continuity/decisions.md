# Decisions

## ADR-001 - `continue` Dispatches Via Active Session Pointer

**Status:** accepted
**Date:** 2026-05-01

### Context

`resume` already uses `readActive(projectDir)` from `src/core/sessions/lifecycle.ts` to find the current session. `attach` scans for a running session when no ID is provided. Users need a single command that picks the right reconnection strategy.

### Decision

When `diptych continue` is called without an argument, use `readActive(projectDir)` as the canonical session pointer. This matches the existing `resume` behavior and avoids inventing a parallel session selection mechanism.

If no active session exists, error with a message directing to `diptych ps` or providing a session ID explicitly.

### Consequences

- `continue` with no arg always targets the same session that `resume` would.
- The `active` file remains the single source of truth for "current session."
- No new session-selection state is introduced.

## ADR-002 - State Detection Uses Existing Primitives

**Status:** accepted
**Date:** 2026-05-01

### Context

The codebase has `checkServerStatus()` for IPC liveness and `isResumable()` for phase-based resumability. These are the exact predicates needed to dispatch between attach and resume.

### Decision

`continue` dispatch logic:

1. `checkServerStatus(sessDir).alive === true` -> attach path (session has a running background server)
2. `loadState(projectDir, sessionId)` + `isResumable(state)` -> resume path (session is interrupted but resumable)
3. State is `complete`, missing, or not resumable -> error with clear message explaining why

### Consequences

- No new state detection logic is needed.
- Dispatch is deterministic and testable.
- Existing `attachCommand` and resume logic are reused, not duplicated.

## ADR-003 - "Most Recent" Uses Lockfile Start Time

**Status:** accepted
**Date:** 2026-05-01

### Context

`diptych last` needs a definition of "most recent." There are two timestamps available: `lockfile.startTimeMs` (written at session creation, always present for sessions that ran) and `summary.json:startedAt` (written only after session completes or interrupts).

### Decision

Use `lockfile.startTimeMs` descending (newest first). This matches the sort order already used by `ps` at `src/cli/commands/ps.ts:91` and works for in-progress sessions that don't yet have a `summary.json`.

### Consequences

- `last` works for running sessions, not just completed ones.
- Sort order is consistent with `ps` display.
- Sessions without a lockfile (corrupt/partial) are excluded.

## ADR-004 - Numeric Aliases Are Derived, Not Persisted

**Status:** accepted
**Date:** 2026-05-01

### Context

Numeric aliases (`1`, `2`, `3`) provide ergonomic shortcuts for session IDs. They could be persisted in a mapping file or derived fresh each time from the sorted session list.

### Decision

Derive aliases at display/resolution time from the same sort order `ps` uses (`lockfile.startTimeMs` descending). Alias `1` = newest session. No file is written.

### Consequences

- Aliases are stable as long as the session set doesn't change between commands.
- No stale-alias problem (deleting a session doesn't leave dangling references).
- No new files in `.diptych/`.
- Slight theoretical race: if a new session starts between `ps` and `continue 2`, the numbering shifts. Acceptable for interactive CLI usage.

## ADR-005 - Backward Compatibility Preserved

**Status:** accepted
**Date:** 2026-05-01

### Context

Existing users and scripts may use `attach` and `resume` directly.

### Decision

`attach` and `resume` remain as-is. They are low-level primitives. `continue` is the recommended UX command for interactive use but does not replace or deprecate the others.

### Consequences

- No breaking changes.
- Documentation can recommend `continue` as the default without removing existing commands.
- `attach` gains numeric alias support (from brief 03) as a natural extension.

## ADR-006 - Fallback To Single Running Session When No Active Pointer

**Status:** accepted
**Date:** 2026-05-01

### Context

`readActive(projectDir)` is the primary session pointer, but it may be cleared (e.g., after `clearActive`) or missing (e.g., a session was started with `--detach` but the active file was never written). If no active pointer exists but exactly one session is running (IPC alive), the user's intent is unambiguous.

### Decision

When `continue` is called without an explicit argument AND `readActive` returns null, scan for running sessions. If exactly one session has a live IPC server, use it. If zero or multiple are running, error with a message directing to `diptych ps`.

### Consequences

- Covers the case where a detached session is the only thing running but has no active pointer.
- Does not conflict with ADR-001; this is a fallback when the primary pointer is absent.
- Multiple running sessions still require explicit disambiguation.

## ADR-007 - `continue` Is A Reserved Word In JavaScript

**Status:** accepted
**Date:** 2026-05-01

### Context

The file can be named `continue.ts` (filenames are strings, not identifiers), but the exported function cannot be named `continue`.

### Decision

- File: `src/cli/commands/continue.ts`
- Exported function: `continueCommand`
- Commander registration: `.command('continue [session-id]')`

### Consequences

- Follows existing pattern (`attachCommand`, `detachCommand`, `psCommand`).
- No naming conflict at runtime.
