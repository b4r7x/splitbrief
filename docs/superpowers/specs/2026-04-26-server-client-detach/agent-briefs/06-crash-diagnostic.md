# 06 — Crash Diagnostic

> Fresh AI context brief. Implement only this change. Never stage or commit.
> Phase: **A**

## Goal

When `diptych attach` targets a session whose server has crashed or exited uncleanly, show a clear diagnostic panel before offering the user next steps. This prevents silently attaching to a dead session or, worse, failing with a confusing socket-not-found error.

Deliverables:

1. A crash diagnostic reader (`src/engine/ipc/crash-diagnostic.ts`) that builds a human-readable summary from `lockfile.json` and `server.log`.
2. A CLI-level display function called by `attachCommand` (from brief 04) when the server is not alive.
3. Two new engine event variants (`server_crashed_detected`, `server_post_mortem_shown`).

## Read First

- `CLAUDE.md`
- `docs/superpowers/specs/2026-04-26-server-client-detach/README.md`
- `docs/superpowers/specs/2026-04-26-server-client-detach/decisions.md` (ADR-008)
- `src/core/paths.ts`
- `src/engine/ipc/lockfile.ts` (from brief 03 — read before writing; `LockfileData`, `ServerStatus`)
- `src/engine/events/types.ts`

## Files To Touch

- `src/engine/ipc/crash-diagnostic.ts` — new
- `src/engine/ipc/crash-diagnostic.test.ts` — new
- `src/engine/events/types.ts` — add new event variants

Do not touch CLI command files (brief 04 owns `attach.ts`; this module is imported by it). Do not touch TUI files.

## Crash Diagnostic Contract

Create `src/engine/ipc/crash-diagnostic.ts`:

```ts
import type { LockfileData, ServerStatus } from './lockfile.js';

export type CrashDiagnostic = {
  sessionId: string;
  status: 'crashed' | 'exited';
  pid: number | null;
  startedAt: number | null;
  lastAliveAt: number | null;
  exitedAt: number | null;
  signal: string | null;
  exitCode: number | null;
  cause: string | null;
  logTail: string | null;  // last 20 lines of server.log, or null if unavailable
};

export async function buildCrashDiagnostic(
  sessionDir: string,
  status: ServerStatus,
): Promise<CrashDiagnostic>;

export function formatCrashDiagnostic(diag: CrashDiagnostic): string;

export async function showCrashDiagnostic(sessionDir: string, status: ServerStatus): Promise<void>;
```

`buildCrashDiagnostic`:

1. Extract fields from `status.data` (or fill with `null` if `data` is null).
2. Attempt to read the last 20 lines of `server.log` (path: `join(sessionDir, SERVER_LOG_FILE)`). If the file does not exist or read fails, set `logTail = null`.
3. Return the `CrashDiagnostic` object.

`formatCrashDiagnostic`:

Pure function. Returns a human-readable multi-line string like:

```
╔══════════════════════════════════════════╗
║  Session abc123 — CRASHED                ║
╚══════════════════════════════════════════╝

  Session ID   : abc123
  PID          : 12345
  Started      : 2026-04-26 14:32:10 UTC
  Last alive   : 2026-04-26 14:47:22 UTC  (3m 14s ago)
  Exit signal  : SIGKILL

  Last 5 lines of server.log:
  ─────────────────────────────────────────
  Error: ENOMEM: cannot allocate memory
  at Object.<anonymous> (/...server-entry.js:42:11)
  ...
  ─────────────────────────────────────────

  Options:
    [1] Start a new workflow for the same feature
    [2] Exit and inspect logs manually
```

The exact formatting is illustrative; match it as closely as practical using plain ASCII box characters and consistent indentation. No color library.

`showCrashDiagnostic`:

1. Call `buildCrashDiagnostic`.
2. Print `formatCrashDiagnostic(diag)` to `process.stdout`.
3. If `status.data` is not null and `status.data.exitedAt` is defined (clean exit case), print a different header: `Session <id> — EXITED CLEANLY` and omit the log tail section.
4. Print the "Options" footer.
5. Wait for a single keypress (`process.stdin`) in raw mode:
   - `1`: print `"Starting new workflow..."` and return (caller handles the actual re-run).
   - `2` or any other key: `process.exit(0)`.

## Events

Add to `src/engine/events/types.ts`:

```ts
| { type: 'server_crash_detected'; ts: number; phase: Phase; sessionId: string; pid: number | null; signal: string | null }
| { type: 'server_post_mortem_shown'; ts: number; phase: Phase; sessionId: string }
```

These events are not published to the dead server's bus (it is gone). They are published to a local ephemeral bus created by the `attachCommand` for CLI-side observability (e.g., telemetry hooks). If no bus is available in the CLI context, skip publishing.

## Log Tail Helper

Implement reading the last N lines of a file without loading the whole file:

```ts
async function readLastLines(filePath: string, n: number): Promise<string | null>;
```

Use a small backward-scan implementation or Node's `readline` reading from a reverse-line stream. Do not use `tail -n` subprocess calls (not portable).

A simple correct approach: read the entire file if it is under 100 KB; for larger files, read the last 32 KB and split on `\n`. This is a diagnostic tool; correctness for huge logs is secondary to simplicity.

## Tests

`src/engine/ipc/crash-diagnostic.test.ts`:

- `buildCrashDiagnostic` returns `null`-filled fields when `status.data` is null.
- `buildCrashDiagnostic` extracts correct fields from a valid `LockfileData`.
- `buildCrashDiagnostic` reads log tail from `server.log` when it exists.
- `buildCrashDiagnostic` sets `logTail = null` when `server.log` does not exist.
- `formatCrashDiagnostic` includes the session ID, PID, and last-alive time in the output string.
- `formatCrashDiagnostic` includes "CRASHED" for crashed status and "EXITED CLEANLY" for clean exit.
- `formatCrashDiagnostic` includes log tail lines when present.
- `formatCrashDiagnostic` omits log tail section when `logTail` is null.
- `formatCrashDiagnostic` is a pure function — no side effects, no async.
- `showCrashDiagnostic` calls `buildCrashDiagnostic` and writes output to stdout (spy on `process.stdout.write`).

## Acceptance Criteria

- `buildCrashDiagnostic`, `formatCrashDiagnostic`, and `showCrashDiagnostic` exported from `src/engine/ipc/crash-diagnostic.ts`.
- `formatCrashDiagnostic` is pure and testable without I/O.
- Two new event variants added to `src/engine/events/types.ts`.
- Log tail is read without loading the full file into memory for large `server.log` files.
- All tests pass.
- `npm run test-ci` passes.

## Verification Commands

```bash
npm test -- src/engine/ipc/crash-diagnostic.test.ts
npm run typecheck
npm run lint
npm test
```
