# 02 — Resource Resolver

> Fresh AI context brief. Implement only this change. Never stage or commit.

## Goal

Implement `src/engine/mcp/resolver.ts`: given a `mcp://diptych/sessions/{id}/...` URI, return the MIME type and text content by reading from `.diptych/sessions/<id>/` on disk. Also implement `types.ts` (shared MCP type definitions used by both this file and the handler). Synthesize `manifest.json` at request time for sessions that never had a handoff pack generated.

## Read First

- `CLAUDE.md`
- `docs/LAYERS.md`
- `src/core/paths.ts`
- `src/core/sessions/io.ts` — `listAllSessions(projectDir)`, `listSessions(projectDir)`
- `src/core/state/persistence.ts` — `loadState(projectDir, sessionId)`
- `src/core/schemas/session.ts` — `Session` type
- `src/engine/handoff/manifest.ts` — handoff manifest schema (for synthesized manifest shape reference)

## Files To Touch

- `src/engine/mcp/types.ts` new
- `src/engine/mcp/resolver.ts` new
- `src/engine/mcp/resolver.test.ts` new

Do not touch `handlers.ts`, `server.ts`, or CLI files in this brief.

## Contract

### `src/engine/mcp/types.ts`

```ts
export type McpRequest = {
  jsonrpc: '2.0';
  id: string | number;
  method: string;
  params?: Record<string, unknown>;
};

export type McpNotification = {
  jsonrpc: '2.0';
  method: string;
  params?: Record<string, unknown>;
};

export type McpResponse = {
  jsonrpc: '2.0';
  id: string | number;
  result: unknown;
};

export type McpError = {
  jsonrpc: '2.0';
  id: string | number | null;
  error: { code: number; message: string; data?: unknown };
};

export type McpResourceDescriptor = {
  uri: string;
  name: string;
  description?: string;
  mimeType?: string;
};

export type McpResourceContent = {
  uri: string;
  mimeType: string;
  text?: string;
  blob?: string;
};
```

### `src/engine/mcp/resolver.ts`

```ts
import type { McpResourceDescriptor, McpResourceContent } from './types.js';

export type McpResolverConfig = {
  projectDir: string;
  sessionIds: string[]; // IDs of sessions this resolver is allowed to serve
  diptychVersion: string;
};

export type McpResolver = {
  listResources(): McpResourceDescriptor[];
  readResource(uri: string): McpResourceContent | null;
};

export function createResolver(config: McpResolverConfig): McpResolver;
```

`createResolver` returns an object with two methods. No class keyword.

## URI Routing

The resolver handles the following URI patterns. All URIs are plain strings; parse them with simple prefix matching + split.

**`mcp://diptych/sessions`**
Name: `"Sessions list"`. MIME: `application/json`.
Content: JSON array of session descriptors:
```ts
Array<{ id: string; title: string; mode: string; startedAt: number; status: string }>
```
Read from `listAllSessions` results filtered to `config.sessionIds`.

**`mcp://diptych/sessions/{id}/manifest.json`**
Name: `"Session manifest ({id})"`. MIME: `application/json`.
Content: synthesized manifest (see below).

**`mcp://diptych/sessions/{id}/spec.md`**
Name: `"Spec ({id})"`. MIME: `text/markdown`.
Content: raw file bytes from `.diptych/sessions/{id}/spec.md`.

**`mcp://diptych/sessions/{id}/plan.md`**
Name: `"Plan ({id})"`. MIME: `text/markdown`.
Content: raw file bytes from `.diptych/sessions/{id}/plan.md`.

**`mcp://diptych/sessions/{id}/tasks`**
Name: `"Task list ({id})"`. MIME: `application/json`.
Content: JSON array:
```ts
Array<{ id: string; title: string; action: string; file: string; status: string }>
```
Parsed from `tasks.md` using the existing task parser. If `tasks.md` does not exist, return `[]`.

**`mcp://diptych/sessions/{id}/tasks/{taskId}`**
Name: `"Task {taskId} ({id})"`. MIME: `text/markdown`.
Content: raw text of the matching task section from `tasks.md`. If the task does not exist, return `null` (caller returns resource-not-found).

**`mcp://diptych/sessions/{id}/evidence.json`**
Name: `"Evidence ({id})"`. MIME: `application/json`.
Content: raw file bytes from `.diptych/sessions/{id}/evidence.json`.

**`mcp://diptych/sessions/{id}/drift-report.json`**
Name: `"Drift report ({id})"`. MIME: `application/json`.
Content: raw file bytes from `.diptych/sessions/{id}/drift-report.json`.

**`mcp://diptych/sessions/{id}/state.json`**
Name: `"Workflow state ({id})"`. MIME: `application/json`.
Content: raw file bytes from `.diptych/sessions/{id}/state.json`.

**`mcp://diptych/sessions/{id}/summary.json`**
Name: `"Summary ({id})"`. MIME: `application/json`.
Content: raw file bytes from `.diptych/sessions/{id}/summary.json`.

## `listResources` Behavior

Return one `McpResourceDescriptor` for each URI where the underlying file exists on disk (or the URI is derived, like `sessions` or `manifest.json` or `tasks`). Always include:
- `mcp://diptych/sessions`
- `mcp://diptych/sessions/{id}/manifest.json` — always synthesizable if `summary.json` exists
- `mcp://diptych/sessions/{id}/tasks` — always listable (may be empty)

Include the following only when the file exists in the session directory:
- `spec.md`, `plan.md`, `evidence.json`, `drift-report.json`, `state.json`, `summary.json`

Include `mcp://diptych/sessions/{id}/tasks/{taskId}` entries only for task IDs found in `tasks.md`.

Use `existsSync` checks. This is called at request time — no caching.

## `readResource` Behavior

Return `McpResourceContent | null`. Return `null` when:
- The URI is not in the served URI set.
- A required file does not exist on disk.
- A task ID is not found in `tasks.md`.

Never throw. Wrap disk reads in try/catch; return `null` on any read error.

## Synthesized `manifest.json`

When serving `mcp://diptych/sessions/{id}/manifest.json`, construct the object at request time:

```ts
{
  packVersion: "1",
  diptychVersion: config.diptychVersion,
  generatedAt: new Date().toISOString(),
  sessionId: id,
  briefHash: readBriefHash(projectDir, id) ?? undefined,  // from brief-hash.json if present
  sourceCommit: readGitHead(projectDir) ?? undefined,       // from .git/HEAD if in a git repo
  target: "live-mcp",
  mode: session.mode,
  taskIds: tasksFromState ?? [],
  artifacts: {
    spec: specExists ? "spec.md" : undefined,
    plan: planExists ? "plan.md" : undefined,
    tasks: existingTaskFiles,   // array of relative task paths like ["tasks/T001.md"]
  },
  validation: session.validation ?? undefined,  // from session if present
}
```

Read `briefHash` from `.diptych/sessions/{id}/brief-hash.json` if it exists (field `hash`). If not, omit.
Read `sourceCommit` from `.git/HEAD` relative to `projectDir` if it's a plain SHA (not a symbolic ref). If not, omit.
Serialize with `JSON.stringify(manifest, null, 2)`.

## Paths Constants

The following constants already exist in `src/core/paths.ts` — use them:
- `SPEC_FILE`, `PLAN_FILE`, `TASKS_FILE`, `STATE_FILE`, `EVIDENCE_FILE`, `DRIFT_REPORT_FILE`

Use `sessionDir(projectDir, id)` for the base path. `summary.json` is `join(sessionDir, 'summary.json')` (no named constant — use the literal).

## Task Parsing

For `tasks` and `tasks/{taskId}` URIs, read `tasks.md` and extract tasks. Use the existing parser in `src/engine/spec/parser.ts` if the signature makes this easy. If it requires a full parse, extract the task list and filter by ID. Do not re-implement the parser; import and call it.

If `tasks.md` does not exist, `tasks` returns `[]`. If a `taskId` is not found, `readResource` returns `null`.

## Tests

Place tests in `src/engine/mcp/resolver.test.ts`. Use `tmp` directories or mock `existsSync`/`readFileSync` to avoid real filesystem state.

Cover:

- `listResources` includes `mcp://diptych/sessions` and `manifest.json` URIs always
- `listResources` omits `plan.md` URI when no `plan.md` file exists (e.g. `instant` mode)
- `listResources` includes `spec.md` URI when file exists
- `listResources` includes task URIs for tasks found in `tasks.md`
- `readResource('mcp://diptych/sessions')` returns valid JSON array
- `readResource('mcp://diptych/sessions/{id}/manifest.json')` returns synthesized manifest with correct shape
- Synthesized manifest has `target: "live-mcp"`
- Synthesized manifest omits `briefHash` when `brief-hash.json` is absent
- `readResource('mcp://diptych/sessions/{id}/spec.md')` returns MIME `text/markdown` and file text
- `readResource('mcp://diptych/sessions/{id}/evidence.json')` returns `null` when file does not exist
- `readResource('mcp://diptych/sessions/{id}/tasks/T001')` returns markdown for that task
- `readResource('mcp://diptych/sessions/{id}/tasks/T999')` returns `null` when not found
- `readResource` with an unknown URI returns `null`
- `readResource` does not throw on disk errors — returns `null`

## Acceptance Criteria

- All listed URI patterns resolve correctly.
- Files missing from disk produce `null`, not an exception.
- Synthesized `manifest.json` shape matches handoff-pack ADR-005 schema.
- `src/engine/mcp/resolver.ts` has zero imports from `ink`, `react`, or `src/features/`.
- `npm run test-ci` passes.

## Verification Commands

```bash
npm test -- src/engine/mcp/resolver.test.ts
npm run typecheck
npm run lint
```
