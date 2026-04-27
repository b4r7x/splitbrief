# 05 — Auth Token & Session Discovery

> Fresh AI context brief. Implement only this change. Never stage or commit.

## Goal

Implement two pure utilities in `src/engine/mcp/`:

1. `auth-token.ts` — generate a cryptographically random Bearer token at process startup.
2. `discovery.ts` — resolve which session IDs should be served given CLI flags and project state.

These are the smallest units in the MCP server chain and have no dependencies on the other MCP briefs. Implement them first.

## Read First

- `CLAUDE.md`
- `docs/LAYERS.md`
- `src/core/sessions/io.ts` — `listAllSessions(projectDir)`, `listSessions(projectDir)`
- `src/core/sessions/lifecycle.ts` — `readActive(projectDir)`

## Files To Touch

- `src/engine/mcp/auth-token.ts` new
- `src/engine/mcp/auth-token.test.ts` new
- `src/engine/mcp/discovery.ts` new
- `src/engine/mcp/discovery.test.ts` new

Do not modify any existing files in this brief.

## Contract

### `src/engine/mcp/auth-token.ts`

```ts
/**
 * Generate a cryptographically random Bearer token.
 * Uses 32 bytes from crypto.randomBytes, encoded as base64url.
 * Returns a string of approximately 43 characters with no padding.
 * The token is held in memory only — never written to disk.
 */
export function generateToken(): string;
```

Implementation:

```ts
import { randomBytes } from 'node:crypto';

export function generateToken(): string {
  return randomBytes(32).toString('base64url');
}
```

That is the complete implementation. No configuration, no salt, no expiry. One function, one import.

### `src/engine/mcp/discovery.ts`

```ts
export type SessionDiscoveryOpts = {
  session?: string;        // --session <id>
  allSessions?: boolean;   // --all-sessions
};

/**
 * Resolve the session IDs the MCP server should serve.
 *
 * - If `opts.session` is set: return [opts.session] if the session directory exists.
 *   Throw if the session cannot be found.
 * - If `opts.allSessions` is true: return all session IDs from listAllSessions.
 *   Throw if no sessions exist.
 * - If neither is set: return [activeId] where activeId = readActive(projectDir).
 *   Throw if no active session exists.
 *
 * opts.session and opts.allSessions must not both be set — the caller is responsible
 * for this invariant (enforced in the CLI command, brief 04).
 */
export function resolveSessionIds(
  projectDir: string,
  opts: SessionDiscoveryOpts,
): string[];
```

Note: `resolveSessionIds` is synchronous. All underlying calls (`readActive`, `listAllSessions`) are synchronous. Do not make it async.

## Session Existence Check

For `opts.session`, verify the session directory exists:

```ts
import { existsSync } from 'node:fs';
import { sessionDir } from '../../core/paths.js';

const dir = sessionDir(projectDir, opts.session);
if (!existsSync(dir)) {
  throw new Error(`Session not found: ${opts.session}`);
}
```

For `opts.allSessions`, call `listAllSessions(projectDir)` and map to `.id`. If the array is empty, throw:

```ts
throw new Error('No sessions found in this project.');
```

For the default case, call `readActive(projectDir)`. If it returns `null` or `undefined`, throw:

```ts
throw new Error('No active session. Use --session <id> or --all-sessions.');
```

## Error Format

All errors thrown by `resolveSessionIds` are plain `Error` instances with human-readable messages. The CLI command (brief 04) catches these and prints them to stderr before exiting with code 1.

## Tests

### `src/engine/mcp/auth-token.test.ts`

Cover:

- `generateToken()` returns a non-empty string
- Two calls to `generateToken()` return different strings (with overwhelming probability — no retry loop needed)
- The returned string contains only base64url characters (`[A-Za-z0-9_-]`)
- The returned string is approximately 43 characters (32 bytes in base64url, no padding = 43 chars exactly)

### `src/engine/mcp/discovery.test.ts`

Use a temporary directory to create fake session directories, or mock `listAllSessions` and `readActive`.

Cover:

- `resolveSessionIds` with `{ session: 'abc' }` returns `['abc']` when directory exists
- `resolveSessionIds` with `{ session: 'missing' }` throws with "Session not found"
- `resolveSessionIds` with `{ allSessions: true }` returns all session IDs from `listAllSessions`
- `resolveSessionIds` with `{ allSessions: true }` throws when no sessions exist
- `resolveSessionIds` with `{}` returns `[activeId]` when active session exists
- `resolveSessionIds` with `{}` throws when no active session

## Acceptance Criteria

- `generateToken()` always returns a 43-character base64url string.
- `resolveSessionIds` never returns an empty array — it always throws instead.
- Both modules have zero imports from `ink`, `react`, or `src/features/`.
- `npm run test-ci` passes.

## Verification Commands

```bash
npm test -- src/engine/mcp/auth-token.test.ts src/engine/mcp/discovery.test.ts
npm run typecheck
npm run lint
```
