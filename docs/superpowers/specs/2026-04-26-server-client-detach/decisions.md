# Decisions

## ADR-001 — IPC Mechanism: Unix Domain Socket

**Status:** accepted

### Context

Candidate transports: Unix domain sockets, named pipes (Windows), TCP loopback, shared memory. The server and client always run on the same machine. Latency and throughput requirements are low (events are small JSON lines).

### Decision

Use a Unix domain socket at `.diptych/sessions/<id>/ipc.sock`. On Windows (where Unix sockets have limited support in older Node versions and are not first-class), `diptych start`, `diptych attach`, and `diptych ps` print an "IPC not supported on Windows" message and exit 1. The existing inline-attach path continues to work on Windows unchanged.

### Consequences

- Zero new runtime dependencies (Node's `net` module supports Unix sockets natively on macOS and Linux).
- The socket path is deterministic from the session ID, so attach/detach/ps all find it without a registry.
- Windows users are not broken for the default `diptych start` workflow; they simply cannot use the daemon features.

---

## ADR-002 — Wire Protocol: Newline-Delimited JSON

**Status:** accepted

### Context

The event bus already serializes events to `session.jsonl` as newline-delimited JSON. An IPC protocol that mirrors this format lets the server reuse the same serialization and lets the client reuse the same deserialization.

### Decision

All messages on the socket are newline-delimited JSON (`\n` terminator). Each line is one complete JSON object. The client must buffer until `\n` and not assume chunk boundaries align with message boundaries. Framing is always `\n`; `\r\n` is not emitted but is tolerated on read.

The message schema is defined in `src/engine/ipc/protocol.ts` (new file, engine layer). Two directions:

- **Server → Client** (`ServerMessage`): `{ kind: 'event'; payload: EngineEvent }` or `{ kind: 'session_meta'; sessionId: string; startedAt: number; mode: WorkflowMode; feature: string }`.
- **Client → Server** (`ClientMessage`): `{ kind: 'user_input'; text: string }` or `{ kind: 'detach' }`.

### Consequences

- Protocol is human-readable and trivially debuggable with `nc`.
- No binary framing, no length-prefix, no schema registry needed.
- Large `planner_text` payloads may span several KB per line — acceptable; Node streams handle this fine.

---

## ADR-003 — Server Lifecycle: Detached Spawn + `.unref()`

**Status:** accepted

### Context

Candidate daemonization strategies: `child_process.fork`, `child_process.spawn` with `detached: true`, writing a PID file and using a separate supervisor, using `pm2` or `node-daemon`.

### Decision

When `diptych start --detach` is invoked:

1. The CLI process calls `child_process.spawn('node', [serverEntrypoint, ...args], { detached: true, stdio: ['ignore', 'ignore', serverLogFd] })`.
2. It calls `.unref()` on the child so the parent's event loop exits immediately after spawning.
3. The server process writes `lockfile.json` (see ADR-004) as soon as it is ready to accept connections.
4. The parent polls `lockfile.json` for up to 3 seconds to confirm the server started, then prints the session ID and exits.

No new npm dependencies. No supervisor. The server process is fully orphaned after the parent exits — it is a self-contained Node process that cleans up on SIGTERM/SIGINT.

### Consequences

- Minimal complexity: diptych already knows how to run Node subprocesses.
- No daemon-restart logic: if the server crashes, it stays dead. Crash diagnostics (ADR-008) handle detection.
- The server entry point is `src/engine/ipc/server-entry.ts`; it is a thin wrapper that calls `startIpcServer(...)` then `runWorkflow(...)`.
- Stderr of the server is redirected to `.diptych/sessions/<id>/server.log`.

---

## ADR-004 — Lockfile Semantics: PID + Heartbeat

**Status:** accepted

### Context

Any attach/ps/detach command needs to know whether a server is running. UNIX signals (`kill -0 <pid>`) alone are not sufficient because PIDs can be reused after the process exits.

### Decision

The server writes `.diptych/sessions/<id>/lockfile.json` with this schema:

```json
{
  "version": 1,
  "pid": 12345,
  "startTimeMs": 1714123456789,
  "lastAliveMs": 1714123460000,
  "sessionId": "abc123",
  "mode": "speckit",
  "feature": "add OAuth login"
}
```

On clean exit the server adds `"exitedAt": <ts>` and `"exitCode": 0` (or `"signal": "SIGTERM"`) and stops updating `lastAliveMs`. On crash the lockfile is left as-is with only `lastAliveMs` outdated.

The server updates `lastAliveMs` every 2 seconds. A server is considered **alive** if:

1. `kill(pid, 0)` succeeds (process exists), AND
2. `now - lastAliveMs < 8000` (3× heartbeat with margin).

A server is considered **crashed** if either condition fails. A server is **cleanly exited** if the lockfile has an `exitedAt` field.

`startTimeMs` is used to guard against PID reuse on long-running machines.

### Consequences

- `diptych ps` can accurately distinguish running / cleanly-exited / crashed sessions without a central registry.
- Heartbeat interval (2 s) and staleness threshold (8 s) are compile-time constants in `src/engine/ipc/heartbeat.ts`.

---

## ADR-005 — Detach Key: Ctrl-D in TUI

**Status:** accepted

### Context

The TUI needs a keypress to detach without killing the server. Ctrl-C is already used for abort/cancel. Ctrl-D is the POSIX EOF signal, but because Ink captures raw stdin, it does not terminate the process the way it would in a shell.

### Decision

Ctrl-D in the TUI sends a `{ kind: 'detach' }` message to the server, then unmounts the Ink app and exits the client process with code 0. The server continues running.

The key binding is not user-configurable in v1. A future config key `workflow.detachKey` can override it.

### Consequences

- No conflict with existing Ctrl-C abort flow.
- Clear UX: the TUI displays "Ctrl-D to detach" in the footer alongside "Ctrl-C to cancel".

---

## ADR-006 — Multiple Clients: Read-Only Fan-Out in Phase A; Single-Writer Input in All Phases

**Status:** accepted

### Context

Phase A ships a single-client constraint (simpler). Phase B relaxes the read constraint. The input (user → server) direction has stronger consistency requirements: two clients sending `/mode` or approval signals simultaneously would corrupt orchestrator state.

### Decision

**Phase A:** The server accepts exactly one client connection. A second `attach` while one client is already attached prints "session already has an attached client; use `--force` to steal" and exits 1.

**Phase B:** The server accepts unlimited read-only clients. The first client to attach acquires the input lock and can send `ClientMessage` payloads. All subsequent clients are put in read-only mode (server sends `{ kind: 'session_meta', readonly: true }` immediately). The input lock is released when the holding client sends `{ kind: 'detach' }` or disconnects.

The `ClientMessage` and `ServerMessage` schemas in `src/engine/ipc/protocol.ts` include a `readonly` flag now so Phase B can be implemented without breaking the wire format.

### Consequences

- Phase A is simple to implement and test.
- Phase B adds fan-out multiplexing at the server; no client changes needed.
- Single-writer invariant is maintained in all phases.

---

## ADR-007 — Backward Compatibility: Inline-Attach Default

**Status:** accepted

### Context

`diptych start` is the primary entry point. Any change that breaks the existing flow is unacceptable.

### Decision

- `diptych start <feature>` (no flags): runs the workflow inline, TUI is the orchestrator process. Behavior is identical to today.
- `diptych start <feature> --detach`: spawns the daemon server, prints the session ID, exits. The user can then `diptych attach` from the same or a different terminal.
- `diptych start --attach <id>` (sugar alias for `diptych attach <id>`): attaches to an existing server.

The `--detach` flag defaults to `false`. No config key changes the default in v1 (to avoid breaking existing CI scripts that rely on the foreground process).

### Consequences

- Zero user-visible change for anyone not using `--detach`.
- CI pipelines continue to work: the process exits when the workflow finishes.
- Users who want daemon behavior opt in explicitly.

---

## ADR-008 — Crash Recovery: Manual-Only, Diagnostic First

**Status:** accepted

### Context

Candidates: auto-restart the server on crash, offer a resume-from-checkpoint flow, or show a diagnostic and let the user decide.

### Decision

No auto-restart. When `diptych attach <id>` targets a crashed server:

1. Read `lockfile.json`. Compute time-since-last-alive and the exit signal/cause if available.
2. Show a diagnostic panel: last-alive timestamp, PID, signal, and any tail of `server.log`.
3. Offer the user two options: (a) start a new workflow for the same feature, (b) exit and inspect logs manually.

"Resume" in the sense of re-entering the orchestrator mid-task is not implemented in v1. The `session.jsonl` is preserved for post-mortem inspection.

### Consequences

- No complexity around partial-task recovery or re-entrant orchestrator state.
- Users have full diagnostic information to decide next steps.
- A future spec can introduce checkpoint-based resume once the evidence/state-snapshot machinery is mature.

---

## ADR-009 — Replay Strategy: Full From Start (Phase C)

**Status:** accepted

### Context

On reattach, the client needs to reconstruct TUI state. Options: re-render from the live stream only (loses history), replay all events from `session.jsonl`, or replay a windowed subset with a user picker.

### Decision

**Phase A:** On attach, the client receives only live events from the moment of connection. The TUI shows a "Attached to running workflow" banner without historical state. This is the simplest correct behavior.

**Phase C:** The server reads all events from `session.jsonl` at attach time and streams them to the new client at high speed (no artificial delay) before switching to live events. The client renders them as if they happened live but skips artificial timing. A progress indicator shows "Replaying N events..." while the burst is in flight. An optional time-based picker ("start from last 2 minutes") trims the replay window.

Full replay from start is the default because events are small and fast; the `session.jsonl` for a 30-minute speckit run is typically under 2 MB.

### Consequences

- Phase A is immediately useful with no replay complexity.
- Phase C makes reattach feel seamless; the TUI shows the full run history.
- The replay window picker is a Phase C polish feature with no Phase A or B dependency.
