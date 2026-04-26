# 03 — Server Process Lifecycle

> Fresh AI context brief. Implement only this change. Never stage or commit.
> Phase: **A**

## Goal

Implement the server process lifetime machinery:

1. A thin server entry point (`src/engine/ipc/server-entry.ts`) that starts the IPC server, runs the workflow, and exits cleanly.
2. A lockfile writer/reader (`src/engine/ipc/lockfile.ts`) that tracks PID, heartbeat, and exit cause.
3. A spawn helper (`src/engine/ipc/spawn-server.ts`) called by `diptych start --detach` to fork the daemon and wait for it to be ready.
4. Orphan detection: check that a PID in `lockfile.json` is actually the same process using `startTimeMs`.

## Read First

- `CLAUDE.md`
- `docs/superpowers/specs/2026-04-26-server-client-detach/README.md`
- `docs/superpowers/specs/2026-04-26-server-client-detach/decisions.md` (ADR-003, ADR-004, ADR-007)
- `src/core/paths.ts`
- `src/engine/orchestrator/run/run.ts` (first 30 lines — understand `RunWorkflowOptions`)
- `src/core/sessions/lifecycle.ts`
- `src/engine/orchestrator/session-lifecycle.ts`

## Files To Touch

- `src/core/paths.ts` — add `LOCKFILE` and `SERVER_LOG_FILE` constants
- `src/engine/ipc/lockfile.ts` — new, lockfile read/write/heartbeat
- `src/engine/ipc/lockfile.test.ts` — new, tests
- `src/engine/ipc/heartbeat.ts` — new, heartbeat constants and interval runner
- `src/engine/ipc/spawn-server.ts` — new, daemon spawn helper
- `src/engine/ipc/spawn-server.test.ts` — new, tests
- `src/engine/ipc/server-entry.ts` — new, server process entry point (no test; it is a side-effecting binary entry)

Do not touch CLI command files (brief 04 owns those) or any TUI files.

## Path Constants

Add to `src/core/paths.ts`:

```ts
export const LOCKFILE = 'lockfile.json';
export const SERVER_LOG_FILE = 'server.log';
```

## Lockfile Contract

Create `src/engine/ipc/lockfile.ts` with exactly these exports:

```ts
export type LockfileData = {
  version: 1;
  pid: number;
  startTimeMs: number;
  lastAliveMs: number;
  sessionId: string;
  mode: string;
  feature: string;
  exitedAt?: number;
  exitCode?: number;
  signal?: string;
  cause?: string;
};

export type ServerStatus =
  | { alive: true; data: LockfileData }
  | { alive: false; crashed: boolean; data: LockfileData | null };

export function writeLockfile(sessionDir: string, data: Omit<LockfileData, 'version'>): Promise<void>;
export function updateHeartbeat(sessionDir: string): Promise<void>;
export function markExited(sessionDir: string, exitCode: number): Promise<void>;
export function markCrashed(sessionDir: string, signal: string, cause?: string): Promise<void>;
export function readLockfile(sessionDir: string): Promise<LockfileData | null>;
export function checkServerStatus(sessionDir: string): Promise<ServerStatus>;
```

`checkServerStatus` rules:

1. If no lockfile exists → `{ alive: false, crashed: false, data: null }`.
2. If lockfile has `exitedAt` → `{ alive: false, crashed: false, data }`.
3. If `kill(data.pid, 0)` throws (process gone) → `{ alive: false, crashed: true, data }`.
4. If `Date.now() - data.lastAliveMs > HEARTBEAT_STALENESS_MS` → `{ alive: false, crashed: true, data }`.
5. Otherwise → `{ alive: true, data }`.

`startTimeMs` in the lockfile is compared against the OS process start time to guard against PID reuse. On macOS use `child_process.execSync('ps -o lstart= -p <pid>')` to get start time. If the start times diverge by more than 2 seconds, treat the process as gone (rule 3 above). Wrap this comparison in a try/catch; if `ps` fails, fall through to rule 4.

## Heartbeat Constants

Create `src/engine/ipc/heartbeat.ts`:

```ts
export const HEARTBEAT_INTERVAL_MS = 2000;
export const HEARTBEAT_STALENESS_MS = 8000;

export function startHeartbeat(sessionDir: string): () => void;
```

`startHeartbeat` calls `setInterval(() => updateHeartbeat(sessionDir), HEARTBEAT_INTERVAL_MS)` and returns a function that calls `clearInterval`. The interval timer must be unref'd (`timer.unref()`) so it does not prevent the Node process from exiting if everything else is done.

## Spawn Helper Contract

Create `src/engine/ipc/spawn-server.ts`:

```ts
export type SpawnServerOptions = {
  sessionDir: string;
  sessionId: string;
  projectDir: string;
  feature: string;
  mode: string;
  configPath: string;
};

export type SpawnServerResult =
  | { ok: true; pid: number; sessionId: string }
  | { ok: false; reason: string };

export async function spawnServer(opts: SpawnServerOptions): Promise<SpawnServerResult>;
```

`spawnServer` must:

1. Determine the server entry point path (`dist/engine/ipc/server-entry.js` for production, `src/engine/ipc/server-entry.ts` for dev using `tsx`).
2. Open `.diptych/sessions/<id>/server.log` for appending (file descriptor for the child's stderr).
3. Call `child_process.spawn('node', [entryPath, ...serialized opts], { detached: true, stdio: ['ignore', 'ignore', serverLogFd] })`.
4. Call `.unref()` on the child.
5. Poll `checkServerStatus(sessionDir)` every 200 ms for up to 3 seconds. Return `{ ok: true, pid, sessionId }` when the lockfile appears and `alive === true`.
6. If 3 seconds elapse without a live lockfile, return `{ ok: false, reason: 'timeout waiting for server to start' }`.

## Server Entry Point

Create `src/engine/ipc/server-entry.ts`. This file is a side-effecting process entry — no unit test.

It must:

1. Parse `process.argv` to extract `sessionId`, `projectDir`, `feature`, `mode`, `configPath`.
2. Create the session directory if it does not exist.
3. Call `writeLockfile(sessionDir, { pid: process.pid, startTimeMs: Date.now(), lastAliveMs: Date.now(), sessionId, mode, feature })`.
4. Start heartbeat (`startHeartbeat(sessionDir)`).
5. Call `startIpcServer(...)` from `src/engine/ipc/server.ts`.
6. Call `runWorkflow(...)` from `src/engine/orchestrator/run/run.ts`.
7. On clean finish: call `markExited(sessionDir, 0)`, stop heartbeat, close IPC server.
8. On SIGTERM/SIGINT: call `markExited(sessionDir, 0)` with signal recorded, stop heartbeat, close IPC server, `process.exit(0)`.
9. On unhandled rejection or uncaught exception: call `markCrashed(sessionDir, 'uncaught', error.message)`, `process.exit(1)`.

## Tests

`src/engine/ipc/lockfile.test.ts`:

- `writeLockfile` creates a valid JSON file with `version: 1`.
- `updateHeartbeat` updates only `lastAliveMs`.
- `markExited` adds `exitedAt` and `exitCode`.
- `markCrashed` adds `signal` and `cause`.
- `readLockfile` returns `null` when file does not exist.
- `checkServerStatus` returns `alive: false, crashed: false, data: null` when no lockfile.
- `checkServerStatus` returns `alive: false, crashed: false` when lockfile has `exitedAt`.
- `checkServerStatus` returns `alive: false, crashed: true` when `lastAliveMs` is stale.
- (Integration) `checkServerStatus` returns `alive: true` for the current process PID with a fresh lockfile.

`src/engine/ipc/spawn-server.test.ts`:

- `spawnServer` returns `{ ok: true }` when a fake server writes a lockfile and `checkServerStatus` returns alive (stub `checkServerStatus`).
- `spawnServer` returns `{ ok: false, reason: 'timeout...' }` when the lockfile never appears within the timeout.
- Spawned child has `detached: true` (inspect spawn call; use a spy on `child_process.spawn`).

## Acceptance Criteria

- `LOCKFILE` and `SERVER_LOG_FILE` added to `src/core/paths.ts`.
- `writeLockfile`, `readLockfile`, `checkServerStatus`, `updateHeartbeat`, `markExited`, `markCrashed` exported from `src/engine/ipc/lockfile.ts`.
- `startHeartbeat` exported from `src/engine/ipc/heartbeat.ts`.
- `spawnServer` exported from `src/engine/ipc/spawn-server.ts`.
- `src/engine/ipc/server-entry.ts` exists and handles SIGTERM + uncaught exceptions.
- All lockfile and spawn tests pass.
- `npm run test-ci` passes.

## Verification Commands

```bash
npm test -- src/engine/ipc/lockfile.test.ts src/engine/ipc/spawn-server.test.ts
npm run typecheck
npm run lint
npm test
```
