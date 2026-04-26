# Decisions

## ADR-001 — HTTP Transport, Not stdio

**Status:** accepted

### Context

MCP supports two transports: stdio (stdin/stdout of a subprocess) and HTTP (client sends POST to a server endpoint). CLI tools (Claude Code, Cursor) typically configure MCP servers as subprocess stdio. However, diptych is already a running process when `mcp serve` is invoked, and stdio conflicts with the existing TUI (Ink renders to stdout).

### Decision

Use HTTP transport. The server listens on 127.0.0.1:`<port>` and receives POST requests containing JSON-RPC 2.0 messages on a fixed path (e.g. `/mcp`).

### Consequences

- Simpler lifecycle: one long-running HTTP process, no subprocess management.
- Easier debugging: `curl` and standard HTTP tooling work directly.
- Consuming tools configure the MCP server as an HTTP endpoint, not stdio. This is supported by Claude Code (`"type": "http"` in MCP config), Cursor, and Windsurf as of 2026.
- Requires auth (ADR-002) because HTTP is less isolated than a named pipe.

### Rejected alternatives

- **stdio.** Conflicts with Ink TUI output; would require spawning a child process from the CLI command, adding unnecessary complexity.
- **WebSocket.** Overkill for request/response RPC; SSE push is explicitly out of scope in v1.

## ADR-002 — Auth: Random Bearer Token Printed At Startup

**Status:** accepted

### Context

The server binds 127.0.0.1 (ADR-006), so network exposure is minimal. However, any process on the local machine can reach 127.0.0.1, so a trivial auth mechanism is warranted to prevent accidental cross-tool contamination.

### Decision

On startup, generate a 32-byte random token via `crypto.randomBytes(32).toString('base64url')`. Print it once to stdout in a copy-pasteable format alongside the server URL. Every HTTP request must carry `Authorization: Bearer <token>`; requests missing or bearing the wrong token receive HTTP 401 with no body. The token is held in process memory only — it is never written to disk.

### Consequences

- Zero persistent secrets; the token is fresh each server start.
- The user copies the token into their MCP client config once per server session.
- Attacker on the same machine who guesses the token still cannot mutate state (read-only server).
- No token rotation in v1; restart the server to rotate.

### Rejected alternatives

- **No auth.** Rejected: any other local process could read live session state, including planner API keys embedded in tool calls.
- **Pre-shared key in config.** Rejected: complicates setup and persists secrets on disk.
- **mTLS.** Rejected: far too heavy for a localhost development tool.

## ADR-003 — URI Scheme: `mcp://diptych/sessions/{id}/...`

**Status:** accepted

### Context

ADR-009 in the handoff-packs spec reserved `mcp://diptych/session/<id>/...` (singular). The MCP Resources URI convention uses the authority component to namespace a server's resources.

### Decision

Use `mcp://diptych/sessions/{id}/...` (plural `sessions`). The full resource set is:

| URI | Content |
|---|---|
| `mcp://diptych/sessions` | List of all sessions (JSON array) |
| `mcp://diptych/sessions/{id}/manifest.json` | Synthesized session manifest (ADR-004) |
| `mcp://diptych/sessions/{id}/spec.md` | Spec content |
| `mcp://diptych/sessions/{id}/plan.md` | Plan content |
| `mcp://diptych/sessions/{id}/tasks` | Task list (JSON array of task IDs + titles) |
| `mcp://diptych/sessions/{id}/tasks/{taskId}` | Single task brief (markdown) |
| `mcp://diptych/sessions/{id}/evidence.json` | Evidence ledger |
| `mcp://diptych/sessions/{id}/drift-report.json` | Drift report |
| `mcp://diptych/sessions/{id}/state.json` | Workflow state |
| `mcp://diptych/sessions/{id}/summary.json` | Session summary (after completion) |

This spec amends ADR-009's reserved prefix from `session` (singular) to `sessions` (plural) to match REST convention. The forward-compat guarantee in ADR-009 concerns the *paths within a session* (`manifest.json`, `tasks/T0NN.md`, `spec.md`) — those remain unchanged.

### Consequences

- Plural matches REST convention and is consistent with the `.diptych/sessions/` directory name.
- Forward compatibility with handoff-pack v1 paths is maintained at the sub-session level.
- Handoff-pack consumers reading `manifest.json` and `tasks/T0NN.md` from a snapshot see the same shape via MCP.

### Rejected alternatives

- **Keep singular `session`** per original ADR-009 wording. Rejected: inconsistent with directory naming and REST convention; the amendment cost is trivial and the ADR-009 author explicitly anticipated this (see ADR-009 rationale).

## ADR-004 — `manifest.json` Is Synthesized At Request Time

**Status:** accepted

### Context

Handoff packs write a `manifest.json` file to disk when the pack is generated. Sessions in the MCP server do not necessarily have a pack — they may be live, in-progress, or completed without ever running `diptych handoff`. There is no `manifest.json` file on disk for a live session.

The product invariant is that a handoff-pack consumer expecting `manifest.json` should work unchanged against an MCP session (ADR-009 forward compat).

### Decision

The resource resolver synthesizes `mcp://diptych/sessions/{id}/manifest.json` at request time from existing session artifacts on disk:

- `summary.json` → `sessionId`, `mode`, `generatedAt`, `taskIds`
- `state.json` → `mode` (canonical), `taskIds` (from state tasks)
- `brief-hash.json` (if present) → `briefHash`
- `git HEAD` (if in git repo) → `sourceCommit`

The synthesized shape mirrors the handoff-pack `manifest.json` schema (ADR-005 of handoff-packs spec) with `packVersion: "1"`, `target: "live-mcp"`, and `diptychVersion` from the running process.

If `summary.json` does not exist for the session, the resolver returns a `resource not found` JSON-RPC error.

### Consequences

- `manifest.json` MCP URI works for any diptych session, not just sessions that had `diptych handoff` run.
- No disk writes from the MCP server (read-only invariant maintained).
- The `artifacts` field in the synthesized manifest lists which session files actually exist on disk.

### Rejected alternatives

- **Return 404/resource-not-found for `manifest.json` on live sessions.** Rejected: breaks ADR-009 forward compat.
- **Require `diptych handoff` before `diptych mcp serve`.** Rejected: defeats the purpose of a live server.

## ADR-005 — Read-Only: No Tools, No Prompts, No Mutations

**Status:** accepted (constitutional weight)

### Context

MCP defines three capability types: Resources (read), Tools (action), and Prompts (template). v1 scope is read-only observability.

### Decision

The MCP server exposes only Resources. It never exposes Tools or Prompts. The JSON-RPC handler must return a proper `method not found` error (code -32601) for `tools/list`, `tools/call`, `prompts/list`, `prompts/get`, `resources/subscribe`, and any unknown method. It never crashes on unknown methods.

### Consequences

- Zero mutation surface in v1.
- Consuming tools that probe for Tool capabilities see an empty or absent capability, not an error.
- The `initialize` response advertises `{ capabilities: { resources: {} } }` only.

### Rejected alternatives

- **Expose a `session/refresh` tool for triggering re-planning.** Rejected: outside v1 scope and violates the read-only stance.

## ADR-006 — Localhost Only: 127.0.0.1

**Status:** accepted

### Context

The server holds session data including Task Briefs, evidence, and potentially provider API-key references in tool call history. Exposing this on a network interface would be a serious security regression.

### Decision

The server always binds to `127.0.0.1` explicitly, never `0.0.0.0` and never a hostname. The `--host` flag is intentionally absent from the CLI. No TLS in v1.

### Consequences

- The server is unreachable from any other machine on any network.
- Docker/container users who need remote access must use `ssh -L` port forwarding — this is documented in the startup announcement, not built in.
- No TLS ceremony; localhost connections do not need it.

### Rejected alternatives

- **Bind to `0.0.0.0` with TLS.** Rejected: TLS management is too heavy for a dev tool, and network exposure of session data is a security risk.
- **Configurable `--host`.** Rejected: too easy to accidentally expose; the use case (container access) is rare and well-served by SSH forwarding.

## ADR-007 — Session Discovery via `listAllSessions`

**Status:** accepted

### Context

Sessions are stored at `.diptych/sessions/<id>/`. The existing `listAllSessions(projectDir)` function in `src/core/sessions/io.ts` reads all session `summary.json` files.

### Decision

The MCP server uses `listAllSessions(projectDir)` to enumerate sessions. When `--session <id>` is given, it serves only that one session. When `--all-sessions` is given (or neither flag is given with an active session), it serves all sessions returned by `listAllSessions`. `--session` and `--all-sessions` are mutually exclusive.

`resources/list` returns one resource entry per available URI across all served sessions. If a session artifact file does not exist on disk (e.g. no `plan.md` for an `instant` mode session), that URI is omitted from the list.

### Consequences

- No new session-listing logic; reuses the existing function.
- Resource list is dynamically computed at each `resources/list` call — reflects live state.
- Sessions with no `summary.json` are silently skipped (consistent with `listAllSessions` behavior).

### Rejected alternatives

- **Cache the resource list at startup.** Rejected: live files may change during a long-running server session; dynamic enumeration is correct.

## ADR-008 — Source Tree: `src/engine/mcp/`, CLI at `src/cli/commands/mcp.ts`

**Status:** accepted

### Context

The engine-vs-CLI layer rule requires: engine code has no React/Ink/features imports; CLI code consumes engine.

### Decision

MCP protocol and resource resolution logic lives in `src/engine/mcp/`:

```
src/engine/mcp/
├── handlers.ts          # JSON-RPC 2.0 envelope, method dispatch
├── handlers.test.ts
├── resolver.ts          # URI → content mapping
├── resolver.test.ts
└── types.ts             # shared MCP type definitions
```

The HTTP server and process lifecycle live in `src/engine/mcp/server.ts`. The CLI command lives at `src/cli/commands/mcp.ts` and imports from `src/engine/mcp/`.

### Consequences

- Engine layer: no React/Ink imports — purely Node.js + existing core modules.
- CLI layer: Commander command wires flags to server startup, handles process signals.
- Test isolation: handlers and resolver are pure enough to test without an HTTP client.

### Rejected alternatives

- **`src/cli/mcp/`.** Rejected: violates layer model — MCP logic would be co-located with CLI concerns and unable to be tested without Commander.
- **`src/features/mcp/`.** Rejected: features layer is React/Ink; MCP server is not UI.

## ADR-009 — Hand-Rolled JSON-RPC 2.0, No `@modelcontextprotocol/sdk`

**Status:** accepted

### Context

`diptych` has no `@modelcontextprotocol/sdk` dependency and the project pattern avoids adding runtime dependencies without strong justification. MCP Resources requires only two methods (`resources/list`, `resources/read`) plus `initialize` and `initialized`. The protocol envelope is JSON-RPC 2.0.

The `@modelcontextprotocol/sdk` package (as of 2026) adds ~200 KB of transitive deps and pulls in several utilities for stdio transport that are irrelevant here.

### Decision

Implement JSON-RPC 2.0 message parsing, dispatch, and serialization by hand in `src/engine/mcp/handlers.ts`. The full surface is:

- Parse incoming JSON body → validate JSON-RPC 2.0 shape.
- Dispatch on `method`:
  - `initialize` → return `{ capabilities: { resources: {} }, serverInfo: { name: "diptych", version }, protocolVersion: "2024-11-05" }`
  - `notifications/initialized` → no-op (notification, no response)
  - `resources/list` → call resolver
  - `resources/read` → call resolver
  - anything else → JSON-RPC error code -32601 (method not found)
- Serialize response or error.

This is approximately 150–200 LOC with no dependencies beyond `node:crypto` (for token) and existing core modules.

### Consequences

- Zero new runtime dependencies.
- Full control over protocol version negotiation.
- Must track MCP spec changes manually if the protocol evolves.
- Implementer must correctly handle JSON-RPC notification shape (no `id` field → no response).

### Rejected alternatives

- **`@modelcontextprotocol/sdk`.** Rejected: adds runtime dependency for a feature that diptych can implement in <200 LOC. The SDK is worthwhile for full MCP servers with Tools, Prompts, and Subscriptions; v1 needs none of those.

## ADR-010 — Single Process, Multi-Session

**Status:** accepted

### Context

The `--all-sessions` flag implies serving multiple sessions from one server instance.

### Decision

One `diptych mcp serve` process serves all requested sessions. The resolver reads from disk at request time — no in-memory session cache, no child processes. Process lifecycle: `SIGINT` / `SIGTERM` close the HTTP server cleanly and exit 0.

### Consequences

- Simple process model: start, serve, stop.
- File reads happen per-request. This is acceptable for a local dev tool; sessions are small.
- No session watching or hot-reload — if a task brief changes on disk, the next `resources/read` returns the updated content automatically.

### Rejected alternatives

- **One process per session.** Rejected: complicates port management and process discovery for consumers.
- **In-memory session cache with file watchers.** Rejected: unnecessary complexity for a dev tool; per-request reads are fast enough.
