# 04 — CLI Attach / Detach / PS

> Fresh AI context brief. Implement only this change. Never stage or commit.
> Phase: **A**

## Goal

Add three new `commander` sub-commands to the diptych CLI:

- `diptych attach [<session-id>]` — connect a TUI client to a running server.
- `diptych detach` — send a detach message to the server of the currently-active session and exit the client (if running inline; usually invoked via Ctrl-D in the TUI).
- `diptych ps` — list all sessions in the current project with their status.

Also extend `diptych start` to accept a `--detach` flag that spawns the server and exits without attaching a TUI.

## Read First

- `CLAUDE.md`
- `docs/superpowers/specs/2026-04-26-server-client-detach/README.md`
- `docs/superpowers/specs/2026-04-26-server-client-detach/decisions.md` (ADR-003, ADR-004, ADR-007)
- `src/core/paths.ts`
- `src/engine/ipc/lockfile.ts` (from brief 03 — read before writing)
- `src/engine/ipc/spawn-server.ts` (from brief 03)
- `src/engine/ipc/protocol.ts` (from brief 01)
- Existing CLI entry point (find with `find src -name 'cli.ts' | head -5`)
- Existing `diptych start` command handler

## Files To Touch

- Existing CLI entry file (wherever `diptych start` is registered — identify by reading first)
- `src/cli/commands/attach.ts` — new
- `src/cli/commands/ps.ts` — new
- `src/cli/commands/attach.test.ts` — new
- `src/cli/commands/ps.test.ts` — new

Do not touch engine or TUI files directly.

## Windows Guard

At the top of `attach.ts` and `ps.ts`, add:

```ts
if (process.platform === 'win32') {
  console.error('diptych attach/detach/ps are not supported on Windows.');
  process.exit(1);
}
```

`diptych start` (inline mode) continues to work on Windows as before.

## `diptych start --detach`

Add `--detach` flag to the existing `start` command:

```ts
.option('--detach', 'spawn workflow as background server and exit', false)
```

When `--detach` is true:

1. Generate (or reuse) session ID.
2. Call `spawnServer({ sessionDir, sessionId, projectDir, feature, mode, configPath })` from `src/engine/ipc/spawn-server.ts`.
3. If result is `{ ok: false }`: print error message, exit 1.
4. If result is `{ ok: true }`: print:
   ```
   Session <sessionId> started (pid <pid>).
   Run: diptych attach <sessionId>
   ```
   Exit 0.

When `--detach` is false (default): run workflow inline, same as today.

## `diptych attach [<session-id>]`

```ts
// src/cli/commands/attach.ts
export async function attachCommand(sessionId: string | undefined, opts: { projectDir: string }): Promise<void>;
```

Steps:

1. If `sessionId` is undefined and there is exactly one running session, use it. If there are zero or multiple, show an interactive picker using the same session picker used by `diptych resume` (read how that picker works first).
2. Resolve the session directory from `sessionId`.
3. Call `checkServerStatus(sessionDir)` from `src/engine/ipc/lockfile.ts`.
4. If `alive: false, crashed: true` or `alive: false, crashed: false` (exited): delegate to brief 06 crash/post-mortem flow. Import `showCrashDiagnostic` from `src/engine/ipc/crash-diagnostic.ts` (created by brief 06).
5. If `alive: true`: compute `sockPath = join(sessionDir, IPC_SOCK_FILE)` and launch the TUI in client mode. The TUI is launched by rendering the `WorkflowScreen` component with an `ipcSockPath` prop instead of an inline `EventBus`.

The TUI integration (wiring `useIpcClient` into `WorkflowScreen`) is explicitly **out of scope** for this brief. Print a placeholder:

```
Attaching to session <sessionId>...
[TUI integration pending — see brief 02]
```

and exit 0. The full TUI wiring is done as a follow-up integration step after all Phase A briefs ship.

## `diptych ps`

```ts
// src/cli/commands/ps.ts
export async function psCommand(opts: { projectDir: string }): Promise<void>;
```

Steps:

1. List all directories under `.diptych/sessions/`.
2. For each directory, call `readLockfile(sessionDir)`.
3. Sort by `startTimeMs` descending (most recent first).
4. Print a table with columns:

```
SESSION ID        STATUS    PID     MODE      ELAPSED    FEATURE
abc123def456      running   12345   speckit   14m 32s    add OAuth login
xyz789            exited    67890   quick     2m 10s     fix typo in docs
ghi012            crashed   11111   standard  5m 00s     refactor auth
```

- `STATUS`: `running` / `exited` / `crashed` / `unknown` (no lockfile).
- `ELAPSED`: compute from `startTimeMs` to `exitedAt` (if exited) or `Date.now()` (if running).
- Align columns with fixed-width padding.
- No color library; use plain spaces.

## Tests

`src/cli/commands/attach.test.ts`:

- Prints error and exits 1 on Windows (mock `process.platform`).
- Calls `showCrashDiagnostic` when server status is crashed (stub `checkServerStatus`).
- Prints "Attaching..." placeholder when server is alive (stub `checkServerStatus`).

`src/cli/commands/ps.test.ts`:

- Prints "no sessions found" when sessions directory is empty.
- Shows one row per session with correct STATUS values (stub `readLockfile`).
- Sorts by `startTimeMs` descending.
- `running` status computed correctly using `checkServerStatus` (stub).
- `ELAPSED` column shows correct duration string.

## Acceptance Criteria

- `diptych start --detach` spawns server and exits with session ID printed.
- `diptych attach <id>` checks server status and branches to crash diagnostic or placeholder TUI.
- `diptych ps` prints a sorted table of all sessions.
- Windows guard is in place for `attach` and `ps`.
- All tests pass.
- `npm run test-ci` passes.

## Verification Commands

```bash
npm test -- src/cli/commands/attach.test.ts src/cli/commands/ps.test.ts
npm run typecheck
npm run lint
npm test
```
