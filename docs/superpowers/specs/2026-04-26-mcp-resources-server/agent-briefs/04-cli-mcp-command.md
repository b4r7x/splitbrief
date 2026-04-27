# 04 — CLI MCP Command

> Fresh AI context brief. Implement only this change. Never stage or commit.

## Goal

Add `diptych mcp serve [--port] [--session] [--all-sessions]` as a Commander subcommand in `src/cli/commands/mcp.ts`. This command wires CLI flags to the server startup functions (briefs 03 and 05) and handles process lifecycle: startup announcement, signal handling, and clean shutdown.

## Read First

- `CLAUDE.md`
- `docs/LAYERS.md`
- `src/cli/commands/handoff.ts` — Commander pattern reference
- `src/engine/mcp/server.ts` (output of brief 03) — `startMcpServer`, `McpServerConfig`
- `src/engine/mcp/resolver.ts` (output of brief 02) — `createResolver`
- `src/engine/mcp/auth-token.ts` (output of brief 05) — `generateToken`
- `src/engine/mcp/discovery.ts` (output of brief 05) — `resolveSessionIds`
- `src/core/sessions/lifecycle.ts` — `readActive(projectDir)`
- `src/cli/setup.ts` — `resolveProjectDir`

## Files To Touch

- `src/cli/commands/mcp.ts` new
- The file that registers CLI commands (e.g. `src/cli.ts` or `src/cli/setup.ts`) — add `registerMcpCommand(program)` registration. Read this file before touching it.

Do not modify `server.ts`, `resolver.ts`, or any engine files.

## Contract

```ts
import { Command } from 'commander';

export function registerMcpCommand(program: Command): void;
```

`registerMcpCommand` registers a `mcp` command with a `serve` subcommand on `program`.

## CLI Shape

```
diptych mcp serve [options]

Options:
  --port <number>      Port to listen on (default: 4321)
  --session <id>       Serve only this session
  --all-sessions       Serve all sessions in the project
  --project <dir>      Project directory (default: cwd)
```

`--session` and `--all-sessions` are mutually exclusive. If both are given, print an error message and exit with code 1 before starting the server.

Default behavior when neither `--session` nor `--all-sessions` is given: resolve the active session using `readActive(projectDir)`. If no active session exists, print an error and exit with code 1.

Port must be a valid integer in the range 1–65535. If the parsed value is out of range or not a number, print an error and exit with code 1.

## Startup Sequence

1. Resolve `projectDir` via `resolveProjectDir(opts.project)`.
2. Validate `--session`/`--all-sessions` exclusivity.
3. Resolve `sessionIds` via `resolveSessionIds(projectDir, opts)` (see brief 05).
4. Generate token via `generateToken()` (see brief 05).
5. Create resolver via `createResolver({ projectDir, sessionIds, diptychVersion })`. Read `diptychVersion` from the `diptych` package (import from `package.json` via `assert { type: 'json' }` or read from a version constant).
6. Start server via `startMcpServer({ port, host: '127.0.0.1', token, resolver, serverVersion: diptychVersion })`.
7. On server ready: print startup announcement to stdout (see below).
8. Register `SIGINT` and `SIGTERM` handlers that call `handle.close()` then `process.exit(0)`.
9. The process stays alive (the HTTP server keeps the event loop open). No `setInterval` needed.

## Startup Announcement

Print to stdout (not stderr) exactly this format, with real values substituted:

```
diptych MCP server ready

  URL:    http://127.0.0.1:4321/mcp
  Token:  <token>
  Sessions: <id1>, <id2>  (or "all" if --all-sessions)

To configure in Claude Code (.claude/settings.json):
  {
    "mcpServers": {
      "diptych": {
        "type": "http",
        "url": "http://127.0.0.1:4321/mcp",
        "headers": { "Authorization": "Bearer <token>" }
      }
    }
  }

Press Ctrl+C to stop.
```

Never print the token to stderr (only stdout, once, at startup). Never log the token in any other message.

## Error Handling

- If `startMcpServer` rejects (e.g. port in use): print `Error: <message>` to stderr and exit with code 1.
- If session resolution finds no valid sessions: print an error and exit with code 1 before generating a token.
- Do not catch `SIGINT`/`SIGTERM` before registering them — only register after the server is confirmed listening.

## Registration

Find the file that registers all CLI commands (it imports `registerHandoffCommand` and calls it on `program`). Add `registerMcpCommand(program)` in the same pattern. Read that file first.

## Tests

Place tests in `src/cli/commands/mcp.test.ts`.

Cover:

- Providing both `--session` and `--all-sessions` exits with code 1 and prints an error
- Invalid port (e.g. `--port abc`, `--port 0`, `--port 99999`) exits with code 1
- When no active session and no flags: exits with code 1 with a useful message

Do not test the full server lifecycle in this brief — that is covered by `server.test.ts`. Mock `startMcpServer` and `generateToken` in unit tests.

## Acceptance Criteria

- `diptych mcp serve` starts without crashing when a valid session exists.
- `--session` and `--all-sessions` conflict is caught before server start.
- The startup announcement is printed once with the correct token and URL.
- `SIGINT` closes the server and exits 0.
- `npm run test-ci` passes.

## Verification Commands

```bash
npm test -- src/cli/commands/mcp.test.ts
npm run typecheck
npm run lint
```
