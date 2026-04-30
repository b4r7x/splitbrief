# P5: MCP Write Tools — Agent → Diptych Feedback

**Date:** 2026-04-30
**Status:** Implementation-ready
**Depends on:** Existing read-only MCP server (`src/engine/mcp/`)

## Problem

Diptych compiles Task Briefs and hands them to external agents (Claude Code, Codex, OpenCode, etc.) via handoff packs or MCP resources. But the feedback loop is broken: agents execute tasks and diptych has no structured way to receive their results. Currently, diptych must parse stdout/stderr from subprocess runners to infer what happened. This is fragile, lossy, and runner-specific.

## Solution

Extend the existing MCP server with **write tools** that external agents can invoke via the standard `tools/list` + `tools/call` MCP protocol. Five tools close the feedback loop:

| Tool | Purpose |
|---|---|
| `report_evidence` | Agent reports observed evidence for a task |
| `report_progress` | Agent reports progress/status update |
| `mark_task_done` | Agent marks a task as completed with results |
| `report_validation_result` | Agent reports test/lint/typecheck results |
| `report_error` | Agent reports an error/failure |

## Architecture

### Integration point

The MCP server (`src/engine/mcp/server.ts`) dispatches to `handleMessage()` in `handlers.ts`. Currently, `handleMessage` takes a `McpResolver` (read-only). We extend it to also accept an `McpToolHandler` (write operations).

```
POST /mcp → handleMessage(body, resolver, toolHandler, serverVersion)
                                          ^^^^^^^^^^
                                          NEW parameter
```

### New files

| File | Purpose |
|---|---|
| `src/engine/mcp/tool-handler.ts` | Tool definitions, dispatch, and per-tool logic |
| `src/engine/mcp/tool-schemas.ts` | Zod input schemas for each tool |
| `src/engine/mcp/tool-handler.test.ts` | Tests for tool handler |

### Modified files

| File | Change |
|---|---|
| `src/engine/mcp/handlers.ts` | Add `tools/list` and `tools/call` dispatch; accept `McpToolHandler` parameter |
| `src/engine/mcp/handlers.test.ts` | Update existing tests, add tool tests |
| `src/engine/mcp/types.ts` | Add `McpToolDefinition` type |

## Detailed Design

### 1. Types (`src/engine/mcp/types.ts`)

Add to existing file:

```typescript
export type McpToolDefinition = {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
};
```

### 2. Tool input schemas (`src/engine/mcp/tool-schemas.ts`)

```typescript
import { z } from 'zod';
import { TaskIdSchema } from '../../core/schemas/task.js';

export const ReportEvidenceInputSchema = z.object({
  sessionId: z.string().min(1),
  taskId: TaskIdSchema,
  observedEvidence: z.array(z.string().min(1)).min(1),
  changedFiles: z.array(z.string()).optional(),
});
export type ReportEvidenceInput = z.infer<typeof ReportEvidenceInputSchema>;

export const ReportProgressInputSchema = z.object({
  sessionId: z.string().min(1),
  taskId: TaskIdSchema,
  message: z.string().min(1),
  percentComplete: z.number().min(0).max(100).optional(),
});
export type ReportProgressInput = z.infer<typeof ReportProgressInputSchema>;

export const MarkTaskDoneInputSchema = z.object({
  sessionId: z.string().min(1),
  taskId: TaskIdSchema,
  changedFiles: z.array(z.string()).min(1),
  observedEvidence: z.array(z.string()).optional(),
  summary: z.string().optional(),
});
export type MarkTaskDoneInput = z.infer<typeof MarkTaskDoneInputSchema>;

export const ReportValidationResultInputSchema = z.object({
  sessionId: z.string().min(1),
  taskId: TaskIdSchema,
  stage: z.enum(['tsc', 'lint', 'test']),
  passed: z.boolean(),
  errorSummary: z.string().optional(),
  changedFiles: z.array(z.string()).optional(),
});
export type ReportValidationResultInput = z.infer<typeof ReportValidationResultInputSchema>;

export const ReportErrorInputSchema = z.object({
  sessionId: z.string().min(1),
  taskId: TaskIdSchema,
  error: z.string().min(1),
  changedFiles: z.array(z.string()).optional(),
  recoverable: z.boolean().optional(),
});
export type ReportErrorInput = z.infer<typeof ReportErrorInputSchema>;
```

### 3. Tool handler (`src/engine/mcp/tool-handler.ts`)

```typescript
import { existsSync } from 'node:fs';
import type { TaskId } from '../../core/schemas/task.js';
import type { EvidenceLedger, EvidenceValidationEntry } from '../../core/schemas/evidence.js';
import type { McpToolDefinition } from './types.js';
import {
  ReportEvidenceInputSchema,
  ReportProgressInputSchema,
  MarkTaskDoneInputSchema,
  ReportValidationResultInputSchema,
  ReportErrorInputSchema,
} from './tool-schemas.js';
import {
  readEvidenceLedger,
  writeEvidenceLedger,
} from '../orchestrator/evidence.js';
import { sessionDir } from '../../core/paths.js';

export type ToolCallResult =
  | { ok: true; content: string }
  | { ok: false; error: string };

export type McpToolHandler = {
  listTools(): McpToolDefinition[];
  callTool(name: string, args: Record<string, unknown>): ToolCallResult;
};

const TOOL_DEFINITIONS: McpToolDefinition[] = [
  {
    name: 'report_evidence',
    description: 'Report observed evidence for a task. Call after completing a verification step (e.g. manual check, code review, or any non-automated validation).',
    inputSchema: {
      type: 'object',
      properties: {
        sessionId: { type: 'string', description: 'Active diptych session ID' },
        taskId: { type: 'string', description: 'Task ID (e.g. T001)' },
        observedEvidence: {
          type: 'array',
          items: { type: 'string' },
          description: 'List of observed evidence statements',
          minItems: 1,
        },
        changedFiles: {
          type: 'array',
          items: { type: 'string' },
          description: 'Project-relative file paths touched',
        },
      },
      required: ['sessionId', 'taskId', 'observedEvidence'],
    },
  },
  {
    name: 'report_progress',
    description: 'Report progress on a task. Call periodically during long-running implementations to update diptych on status.',
    inputSchema: {
      type: 'object',
      properties: {
        sessionId: { type: 'string', description: 'Active diptych session ID' },
        taskId: { type: 'string', description: 'Task ID (e.g. T001)' },
        message: { type: 'string', description: 'Progress message' },
        percentComplete: { type: 'number', minimum: 0, maximum: 100, description: 'Optional completion percentage' },
      },
      required: ['sessionId', 'taskId', 'message'],
    },
  },
  {
    name: 'mark_task_done',
    description: 'Mark a task as completed. Call when all implementation and validation for a task are finished. Requires at least one changed file.',
    inputSchema: {
      type: 'object',
      properties: {
        sessionId: { type: 'string', description: 'Active diptych session ID' },
        taskId: { type: 'string', description: 'Task ID (e.g. T001)' },
        changedFiles: {
          type: 'array',
          items: { type: 'string' },
          description: 'Project-relative file paths modified by this task',
          minItems: 1,
        },
        observedEvidence: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional evidence observed during implementation',
        },
        summary: { type: 'string', description: 'Optional short summary of what was done' },
      },
      required: ['sessionId', 'taskId', 'changedFiles'],
    },
  },
  {
    name: 'report_validation_result',
    description: 'Report a validation result (tsc, lint, or test) for a task. Call after running each validation stage.',
    inputSchema: {
      type: 'object',
      properties: {
        sessionId: { type: 'string', description: 'Active diptych session ID' },
        taskId: { type: 'string', description: 'Task ID (e.g. T001)' },
        stage: { type: 'string', enum: ['tsc', 'lint', 'test'], description: 'Validation stage' },
        passed: { type: 'boolean', description: 'Whether validation passed' },
        errorSummary: { type: 'string', description: 'Error summary if validation failed' },
        changedFiles: {
          type: 'array',
          items: { type: 'string' },
          description: 'Files relevant to this validation',
        },
      },
      required: ['sessionId', 'taskId', 'stage', 'passed'],
    },
  },
  {
    name: 'report_error',
    description: 'Report an error during task implementation. Call when the agent encounters an unrecoverable error or needs diptych to make a recovery decision.',
    inputSchema: {
      type: 'object',
      properties: {
        sessionId: { type: 'string', description: 'Active diptych session ID' },
        taskId: { type: 'string', description: 'Task ID (e.g. T001)' },
        error: { type: 'string', description: 'Error description' },
        changedFiles: {
          type: 'array',
          items: { type: 'string' },
          description: 'Files modified before the error occurred',
        },
        recoverable: { type: 'boolean', description: 'Whether the agent believes a retry might succeed' },
      },
      required: ['sessionId', 'taskId', 'error'],
    },
  },
];

function assertSessionExists(projectDir: string, sessionId: string): string | null {
  const dir = sessionDir(projectDir, sessionId);
  if (!existsSync(dir)) return `Session not found: ${sessionId}`;
  return null;
}

function assertTaskExists(ledger: EvidenceLedger | null, taskId: TaskId): string | null {
  if (!ledger) return 'Evidence ledger not found for this session';
  if (!ledger.tasks.some(t => t.id === taskId)) {
    return `Task not found in evidence ledger: ${taskId}`;
  }
  return null;
}

function uniquePush(arr: string[], value: string): void {
  if (!arr.includes(value)) arr.push(value);
}

function findOrCreateTask(
  ledger: EvidenceLedger,
  taskId: TaskId,
): EvidenceLedger['tasks'][number] | null {
  return ledger.tasks.find(t => t.id === taskId) ?? null;
}

function replaceLedgerTask(
  ledger: EvidenceLedger,
  updated: EvidenceLedger['tasks'][number],
): EvidenceLedger {
  const tasks = ledger.tasks.map(t => t.id === updated.id ? updated : t);
  return {
    ...ledger,
    tasks,
    generatedAt: new Date().toISOString(),
  };
}

function handleReportEvidence(
  projectDir: string,
  args: Record<string, unknown>,
): ToolCallResult {
  const parsed = ReportEvidenceInputSchema.safeParse(args);
  if (!parsed.success) {
    return { ok: false, error: `Invalid input: ${parsed.error.issues.map(i => i.message).join(', ')}` };
  }
  const { sessionId, taskId, observedEvidence, changedFiles } = parsed.data;

  const sessionErr = assertSessionExists(projectDir, sessionId);
  if (sessionErr) return { ok: false, error: sessionErr };

  const ledger = readEvidenceLedger(projectDir, sessionId);
  const taskErr = assertTaskExists(ledger, taskId);
  if (taskErr) return { ok: false, error: taskErr };

  const task = findOrCreateTask(ledger!, taskId);
  if (!task) return { ok: false, error: `Task ${taskId} not found` };

  const updated = { ...task, observedEvidence: [...task.observedEvidence], changedFiles: [...task.changedFiles] };
  for (const ev of observedEvidence) uniquePush(updated.observedEvidence, ev);
  for (const f of changedFiles ?? []) uniquePush(updated.changedFiles, f);

  writeEvidenceLedger(projectDir, sessionId, replaceLedgerTask(ledger!, updated));
  return { ok: true, content: `Recorded ${observedEvidence.length} evidence item(s) for ${taskId}` };
}

function handleReportProgress(
  projectDir: string,
  args: Record<string, unknown>,
): ToolCallResult {
  const parsed = ReportProgressInputSchema.safeParse(args);
  if (!parsed.success) {
    return { ok: false, error: `Invalid input: ${parsed.error.issues.map(i => i.message).join(', ')}` };
  }
  const { sessionId, taskId, message, percentComplete } = parsed.data;

  const sessionErr = assertSessionExists(projectDir, sessionId);
  if (sessionErr) return { ok: false, error: sessionErr };

  const ledger = readEvidenceLedger(projectDir, sessionId);
  const taskErr = assertTaskExists(ledger, taskId);
  if (taskErr) return { ok: false, error: taskErr };

  const task = findOrCreateTask(ledger!, taskId);
  if (!task) return { ok: false, error: `Task ${taskId} not found` };

  const progressEntry = percentComplete !== undefined
    ? `progress: ${message} (${percentComplete}%)`
    : `progress: ${message}`;

  const updated = { ...task, observedEvidence: [...task.observedEvidence] };
  uniquePush(updated.observedEvidence, progressEntry);

  writeEvidenceLedger(projectDir, sessionId, replaceLedgerTask(ledger!, updated));
  return { ok: true, content: `Progress recorded for ${taskId}: ${message}` };
}

function handleMarkTaskDone(
  projectDir: string,
  args: Record<string, unknown>,
): ToolCallResult {
  const parsed = MarkTaskDoneInputSchema.safeParse(args);
  if (!parsed.success) {
    return { ok: false, error: `Invalid input: ${parsed.error.issues.map(i => i.message).join(', ')}` };
  }
  const { sessionId, taskId, changedFiles, observedEvidence, summary } = parsed.data;

  const sessionErr = assertSessionExists(projectDir, sessionId);
  if (sessionErr) return { ok: false, error: sessionErr };

  const ledger = readEvidenceLedger(projectDir, sessionId);
  const taskErr = assertTaskExists(ledger, taskId);
  if (taskErr) return { ok: false, error: taskErr };

  const task = findOrCreateTask(ledger!, taskId);
  if (!task) return { ok: false, error: `Task ${taskId} not found` };

  const updated = {
    ...task,
    status: 'done' as const,
    method: 'mcp-tool' as const,
    changedFiles: [...task.changedFiles],
    observedEvidence: [...task.observedEvidence],
  };

  for (const f of changedFiles) uniquePush(updated.changedFiles, f);
  uniquePush(updated.observedEvidence, 'task reached done');
  if (summary) uniquePush(updated.observedEvidence, `summary: ${summary}`);
  for (const ev of observedEvidence ?? []) uniquePush(updated.observedEvidence, ev);

  const updatedLedger = replaceLedgerTask(ledger!, updated);
  const recomputed = {
    ...updatedLedger,
    validationSummary: recomputeValidationSummary(updatedLedger.tasks),
  };
  writeEvidenceLedger(projectDir, sessionId, recomputed);
  return { ok: true, content: `Task ${taskId} marked done. ${changedFiles.length} file(s) recorded.` };
}

function handleReportValidationResult(
  projectDir: string,
  args: Record<string, unknown>,
): ToolCallResult {
  const parsed = ReportValidationResultInputSchema.safeParse(args);
  if (!parsed.success) {
    return { ok: false, error: `Invalid input: ${parsed.error.issues.map(i => i.message).join(', ')}` };
  }
  const { sessionId, taskId, stage, passed, errorSummary, changedFiles } = parsed.data;

  const sessionErr = assertSessionExists(projectDir, sessionId);
  if (sessionErr) return { ok: false, error: sessionErr };

  const ledger = readEvidenceLedger(projectDir, sessionId);
  const taskErr = assertTaskExists(ledger, taskId);
  if (taskErr) return { ok: false, error: taskErr };

  const task = findOrCreateTask(ledger!, taskId);
  if (!task) return { ok: false, error: `Task ${taskId} not found` };

  const entry: EvidenceValidationEntry = {
    stage,
    passed,
    ...(errorSummary !== undefined && !passed && { errorSummary }),
    ...(changedFiles !== undefined && changedFiles.length > 0 && { changedFiles }),
  };

  const updated = {
    ...task,
    validation: [...task.validation, entry],
    observedEvidence: [...task.observedEvidence],
    changedFiles: [...task.changedFiles],
  };

  if (passed) uniquePush(updated.observedEvidence, `${stage} passed`);
  for (const f of changedFiles ?? []) uniquePush(updated.changedFiles, f);

  writeEvidenceLedger(projectDir, sessionId, replaceLedgerTask(ledger!, updated));
  const statusLabel = passed ? 'passed' : 'failed';
  return { ok: true, content: `Validation ${stage} ${statusLabel} for ${taskId}` };
}

function handleReportError(
  projectDir: string,
  args: Record<string, unknown>,
): ToolCallResult {
  const parsed = ReportErrorInputSchema.safeParse(args);
  if (!parsed.success) {
    return { ok: false, error: `Invalid input: ${parsed.error.issues.map(i => i.message).join(', ')}` };
  }
  const { sessionId, taskId, error, changedFiles, recoverable } = parsed.data;

  const sessionErr = assertSessionExists(projectDir, sessionId);
  if (sessionErr) return { ok: false, error: sessionErr };

  const ledger = readEvidenceLedger(projectDir, sessionId);
  const taskErr = assertTaskExists(ledger, taskId);
  if (taskErr) return { ok: false, error: taskErr };

  const task = findOrCreateTask(ledger!, taskId);
  if (!task) return { ok: false, error: `Task ${taskId} not found` };

  const updated = {
    ...task,
    status: 'failed' as const,
    observedEvidence: [...task.observedEvidence],
    changedFiles: [...task.changedFiles],
  };

  uniquePush(updated.observedEvidence, `error: ${error}`);
  if (recoverable === true) uniquePush(updated.observedEvidence, 'agent reports: recoverable');
  if (recoverable === false) uniquePush(updated.observedEvidence, 'agent reports: unrecoverable');
  for (const f of changedFiles ?? []) uniquePush(updated.changedFiles, f);

  const updatedLedger = replaceLedgerTask(ledger!, updated);
  const recomputed = {
    ...updatedLedger,
    validationSummary: recomputeValidationSummary(updatedLedger.tasks),
  };
  writeEvidenceLedger(projectDir, sessionId, recomputed);
  return { ok: true, content: `Error recorded for ${taskId}: ${error}` };
}

function recomputeValidationSummary(
  tasks: EvidenceLedger['tasks'],
): EvidenceLedger['validationSummary'] {
  const summary = { passed: 0, failed: 0, skipped: 0, escalated: 0 };
  for (const t of tasks) {
    if (t.status === 'skipped') { summary.skipped += 1; continue; }
    if (t.status === 'escalated') summary.escalated += 1;
    if (t.status === 'done') { summary.passed += 1; continue; }
    if (t.status === 'failed') summary.failed += 1;
  }
  return summary;
}

export function createToolHandler(projectDir: string): McpToolHandler {
  return {
    listTools: () => TOOL_DEFINITIONS,
    callTool(name: string, args: Record<string, unknown>): ToolCallResult {
      switch (name) {
        case 'report_evidence':
          return handleReportEvidence(projectDir, args);
        case 'report_progress':
          return handleReportProgress(projectDir, args);
        case 'mark_task_done':
          return handleMarkTaskDone(projectDir, args);
        case 'report_validation_result':
          return handleReportValidationResult(projectDir, args);
        case 'report_error':
          return handleReportError(projectDir, args);
        default:
          return { ok: false, error: `Unknown tool: ${name}` };
      }
    },
  };
}
```

### 4. Handler changes (`src/engine/mcp/handlers.ts`)

The `handleMessage` function signature changes:

```typescript
// BEFORE
export function handleMessage(
  rawBody: string,
  resolver: McpResolver,
  serverVersion: string,
): HandleResult

// AFTER
export function handleMessage(
  rawBody: string,
  resolver: McpResolver,
  serverVersion: string,
  toolHandler?: McpToolHandler,
): HandleResult
```

Add these cases before the `METHOD_NOT_FOUND` return:

```typescript
import type { McpToolHandler } from './tool-handler.js';

// In handleMessage, after resources/read and before the final METHOD_NOT_FOUND:

if (method === 'tools/list') {
  if (!toolHandler) {
    return { kind: 'error', body: jsonRpcError(METHOD_NOT_FOUND, 'Tools not available', id) };
  }
  return {
    kind: 'response',
    body: {
      jsonrpc: '2.0',
      id,
      result: { tools: toolHandler.listTools() },
    },
  };
}

if (method === 'tools/call') {
  if (!toolHandler) {
    return { kind: 'error', body: jsonRpcError(METHOD_NOT_FOUND, 'Tools not available', id) };
  }
  const name = params['name'];
  if (typeof name !== 'string') {
    return { kind: 'error', body: jsonRpcError(INVALID_PARAMS, 'Missing tool name', id) };
  }
  const toolArgs = (params['arguments'] !== undefined && typeof params['arguments'] === 'object' && params['arguments'] !== null)
    ? params['arguments'] as Record<string, unknown>
    : {};

  const result = toolHandler.callTool(name, toolArgs);

  if (result.ok) {
    return {
      kind: 'response',
      body: {
        jsonrpc: '2.0',
        id,
        result: {
          content: [{ type: 'text', text: result.content }],
          isError: false,
        },
      },
    };
  }

  return {
    kind: 'response',
    body: {
      jsonrpc: '2.0',
      id,
      result: {
        content: [{ type: 'text', text: result.error }],
        isError: true,
      },
    },
  };
}
```

Update the `initialize` response to advertise tools capability:

```typescript
// BEFORE
capabilities: { resources: {} },

// AFTER
capabilities: {
  resources: {},
  ...(toolHandler ? { tools: {} } : {}),
},
```

### 5. Server wiring (`src/engine/mcp/server.ts`)

Update `McpServerConfig` to include `toolHandler`:

```typescript
export type McpServerConfig = {
  port: number;
  host: string;
  token: string;
  resolver: McpResolver;
  serverVersion: string;
  toolHandler?: McpToolHandler;  // NEW
};
```

Pass it to `handleMessage`:

```typescript
// BEFORE
result = handleMessage(body, resolver, serverVersion);

// AFTER
result = handleMessage(body, resolver, serverVersion, toolHandler);
```

### 6. CLI wiring (`src/cli/commands/mcp.ts`)

When starting the MCP server, create and pass the tool handler:

```typescript
import { createToolHandler } from '../../engine/mcp/tool-handler.js';

// In the mcp command handler, after creating the resolver:
const toolHandler = createToolHandler(projectDir);
const handle = await startMcpServer({
  port, host, token, resolver, serverVersion,
  toolHandler,  // NEW
});
```

## Security

### Input validation

All tool inputs are validated with Zod schemas before any state mutation. Invalid input returns a structured error without side effects.

### Path confinement

Tool handlers only write to the evidence ledger file within the session directory (`$projectDir/.diptych/sessions/$sessionId/evidence.json`). No arbitrary file paths are written to. The `sessionDir()` helper confines paths to the project's `.diptych/` directory.

The `changedFiles` field in tool inputs is recorded as metadata strings in the evidence ledger — they are never used as file paths for writes. No file I/O occurs against user-supplied paths.

### Session isolation

Each tool call requires a `sessionId`. The handler verifies the session directory exists before any mutation. A tool call for session A cannot write to session B's evidence.

### Auth

Same Bearer token as existing resources — no change. The MCP server rejects unauthenticated requests at the HTTP layer before `handleMessage` is called.

### No status transitions outside evidence

The tools write to the **evidence ledger** only. They do NOT mutate `state.json` (the workflow state machine). The orchestrator reads evidence and makes status decisions through its existing control flow. This prevents external agents from corrupting the state machine.

**Exception:** `mark_task_done` and `report_error` set `status` on the evidence task entry — but this is evidence metadata, not the state machine's task status. The orchestrator's `task-loop.ts` is the sole authority on state transitions.

### TaskCompletionMethod

`mark_task_done` sets `method: 'mcp-tool'` on the evidence task entry. This value must be added to the `TaskCompletionMethodSchema` in `src/core/schemas/enums.ts`:

```typescript
// In enums.ts, add 'mcp-tool' to the TaskCompletionMethod enum:
export const TASK_COMPLETION_METHODS = [
  'direct', 'retry', 'escalated', 'skipped', 'mcp-tool',  // add 'mcp-tool'
] as const;
```

## Tests

### `src/engine/mcp/tool-handler.test.ts`

```typescript
import { describe, it, expect, beforeEach } from 'vitest';
import { mkdirSync, mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createToolHandler } from './tool-handler.js';
import { createEvidenceLedger, writeEvidenceLedger } from '../orchestrator/evidence.js';
import { EvidenceLedgerSchema } from '../../core/schemas/evidence.js';
import { taskId } from '../../core/schemas/task.js';
import { DIPTYCH_DIR, SESSIONS_DIR, EVIDENCE_FILE } from '../../core/paths.js';

function createTestProject(): { projectDir: string; cleanup: () => void } {
  const projectDir = mkdtempSync(join(tmpdir(), 'mcp-tools-test-'));
  return {
    projectDir,
    cleanup: () => rmSync(projectDir, { recursive: true, force: true }),
  };
}

function seedSession(projectDir: string, sessionId: string): void {
  const sessDir = join(projectDir, DIPTYCH_DIR, SESSIONS_DIR, sessionId);
  mkdirSync(sessDir, { recursive: true });
  const ledger = createEvidenceLedger({
    sessionId,
    feature: 'test feature',
    tasks: [
      {
        id: taskId('T001'),
        title: 'First task',
        action: 'modify',
        file: 'src/foo.ts',
        dependsOn: [],
        description: 'Do the thing',
        tests: ['it works'],
        constraints: [],
        typeDefs: '',
        implementationSteps: ['step 1'],
        status: 'in_progress',
      },
      {
        id: taskId('T002'),
        title: 'Second task',
        action: 'create',
        file: 'src/bar.ts',
        dependsOn: [taskId('T001')],
        description: 'Do another thing',
        tests: [],
        constraints: [],
        typeDefs: '',
        implementationSteps: [],
        status: 'pending',
      },
    ],
  });
  writeEvidenceLedger(projectDir, sessionId, ledger);
}

function readLedger(projectDir: string, sessionId: string): ReturnType<typeof EvidenceLedgerSchema.parse> {
  const path = join(projectDir, DIPTYCH_DIR, SESSIONS_DIR, sessionId, EVIDENCE_FILE);
  return EvidenceLedgerSchema.parse(JSON.parse(readFileSync(path, 'utf-8')));
}

describe('MCP tool handler', () => {
  let projectDir: string;
  let cleanup: () => void;

  beforeEach(() => {
    const result = createTestProject();
    projectDir = result.projectDir;
    cleanup = result.cleanup;
    seedSession(projectDir, 'sess-001');
  });

  afterEach(() => cleanup());

  it('listTools returns all 5 tool definitions', () => {
    const handler = createToolHandler(projectDir);
    const tools = handler.listTools();
    expect(tools).toHaveLength(5);
    const names = tools.map(t => t.name);
    expect(names).toContain('report_evidence');
    expect(names).toContain('report_progress');
    expect(names).toContain('mark_task_done');
    expect(names).toContain('report_validation_result');
    expect(names).toContain('report_error');
  });

  it('report_evidence appends observed evidence and changed files to evidence ledger', () => {
    const handler = createToolHandler(projectDir);
    const result = handler.callTool('report_evidence', {
      sessionId: 'sess-001',
      taskId: 'T001',
      observedEvidence: ['component renders correctly', 'no console errors'],
      changedFiles: ['src/foo.ts', 'src/foo.test.ts'],
    });
    expect(result.ok).toBe(true);

    const ledger = readLedger(projectDir, 'sess-001');
    const task = ledger.tasks.find(t => t.id === 'T001')!;
    expect(task.observedEvidence).toContain('component renders correctly');
    expect(task.observedEvidence).toContain('no console errors');
    expect(task.changedFiles).toContain('src/foo.ts');
    expect(task.changedFiles).toContain('src/foo.test.ts');
  });

  it('report_evidence rejects invalid input', () => {
    const handler = createToolHandler(projectDir);
    const result = handler.callTool('report_evidence', {
      sessionId: 'sess-001',
      taskId: 'T001',
      observedEvidence: [],
    });
    expect(result.ok).toBe(false);
  });

  it('report_evidence rejects nonexistent session', () => {
    const handler = createToolHandler(projectDir);
    const result = handler.callTool('report_evidence', {
      sessionId: 'nonexistent',
      taskId: 'T001',
      observedEvidence: ['test'],
    });
    expect(result.ok).toBe(false);
    expect((result as { ok: false; error: string }).error).toContain('Session not found');
  });

  it('report_evidence rejects nonexistent task', () => {
    const handler = createToolHandler(projectDir);
    const result = handler.callTool('report_evidence', {
      sessionId: 'sess-001',
      taskId: 'T999',
      observedEvidence: ['test'],
    });
    expect(result.ok).toBe(false);
    expect((result as { ok: false; error: string }).error).toContain('Task not found');
  });

  it('report_progress records progress message as observed evidence', () => {
    const handler = createToolHandler(projectDir);
    const result = handler.callTool('report_progress', {
      sessionId: 'sess-001',
      taskId: 'T001',
      message: 'Implementing auth flow',
      percentComplete: 60,
    });
    expect(result.ok).toBe(true);

    const ledger = readLedger(projectDir, 'sess-001');
    const task = ledger.tasks.find(t => t.id === 'T001')!;
    expect(task.observedEvidence).toContain('progress: Implementing auth flow (60%)');
  });

  it('mark_task_done sets status, method, changed files, and evidence', () => {
    const handler = createToolHandler(projectDir);
    const result = handler.callTool('mark_task_done', {
      sessionId: 'sess-001',
      taskId: 'T001',
      changedFiles: ['src/foo.ts'],
      observedEvidence: ['all tests pass'],
      summary: 'Refactored auth module',
    });
    expect(result.ok).toBe(true);

    const ledger = readLedger(projectDir, 'sess-001');
    const task = ledger.tasks.find(t => t.id === 'T001')!;
    expect(task.status).toBe('done');
    expect(task.method).toBe('mcp-tool');
    expect(task.changedFiles).toContain('src/foo.ts');
    expect(task.observedEvidence).toContain('task reached done');
    expect(task.observedEvidence).toContain('summary: Refactored auth module');
    expect(task.observedEvidence).toContain('all tests pass');
    expect(ledger.validationSummary.passed).toBeGreaterThanOrEqual(1);
  });

  it('report_validation_result appends validation entry to task', () => {
    const handler = createToolHandler(projectDir);
    const result = handler.callTool('report_validation_result', {
      sessionId: 'sess-001',
      taskId: 'T001',
      stage: 'tsc',
      passed: true,
    });
    expect(result.ok).toBe(true);

    const ledger = readLedger(projectDir, 'sess-001');
    const task = ledger.tasks.find(t => t.id === 'T001')!;
    expect(task.validation).toHaveLength(1);
    expect(task.validation[0]).toMatchObject({ stage: 'tsc', passed: true });
    expect(task.observedEvidence).toContain('tsc passed');
  });

  it('report_validation_result records failed validation with error summary', () => {
    const handler = createToolHandler(projectDir);
    const result = handler.callTool('report_validation_result', {
      sessionId: 'sess-001',
      taskId: 'T001',
      stage: 'test',
      passed: false,
      errorSummary: 'TypeError: Cannot read properties of undefined',
    });
    expect(result.ok).toBe(true);

    const ledger = readLedger(projectDir, 'sess-001');
    const task = ledger.tasks.find(t => t.id === 'T001')!;
    expect(task.validation[0]).toMatchObject({
      stage: 'test',
      passed: false,
      errorSummary: 'TypeError: Cannot read properties of undefined',
    });
  });

  it('report_error marks task failed and records error in evidence', () => {
    const handler = createToolHandler(projectDir);
    const result = handler.callTool('report_error', {
      sessionId: 'sess-001',
      taskId: 'T001',
      error: 'Module not found: @missing/dep',
      changedFiles: ['src/foo.ts'],
      recoverable: false,
    });
    expect(result.ok).toBe(true);

    const ledger = readLedger(projectDir, 'sess-001');
    const task = ledger.tasks.find(t => t.id === 'T001')!;
    expect(task.status).toBe('failed');
    expect(task.observedEvidence).toContain('error: Module not found: @missing/dep');
    expect(task.observedEvidence).toContain('agent reports: unrecoverable');
    expect(task.changedFiles).toContain('src/foo.ts');
    expect(ledger.validationSummary.failed).toBeGreaterThanOrEqual(1);
  });

  it('unknown tool name returns error', () => {
    const handler = createToolHandler(projectDir);
    const result = handler.callTool('nonexistent_tool', {});
    expect(result.ok).toBe(false);
    expect((result as { ok: false; error: string }).error).toContain('Unknown tool');
  });

  it('multiple evidence reports for the same task accumulate without duplicates', () => {
    const handler = createToolHandler(projectDir);
    handler.callTool('report_evidence', {
      sessionId: 'sess-001',
      taskId: 'T001',
      observedEvidence: ['check A'],
    });
    handler.callTool('report_evidence', {
      sessionId: 'sess-001',
      taskId: 'T001',
      observedEvidence: ['check A', 'check B'],
    });

    const ledger = readLedger(projectDir, 'sess-001');
    const task = ledger.tasks.find(t => t.id === 'T001')!;
    const checkACount = task.observedEvidence.filter(e => e === 'check A').length;
    expect(checkACount).toBe(1);
    expect(task.observedEvidence).toContain('check B');
  });
});
```

### `src/engine/mcp/handlers.test.ts` updates

Add to existing test file:

```typescript
// Add a stubToolHandler for tests
const stubToolHandler: McpToolHandler = {
  listTools: () => [
    { name: 'report_evidence', description: 'Report evidence', inputSchema: { type: 'object' } },
  ],
  callTool: (name, args) => {
    if (name === 'report_evidence') return { ok: true, content: 'Evidence recorded' };
    return { ok: false, error: `Unknown tool: ${name}` };
  },
};

it('tools/list → returns tool definitions when handler present', () => {
  const result = handleMessage(
    msg({ jsonrpc: '2.0', id: 20, method: 'tools/list' }),
    makeResolver(),
    SERVER_VERSION,
    stubToolHandler,
  );
  expect(result.kind).toBe('response');
  if (result.kind !== 'response') return;
  const r = result.body.result as { tools: unknown[] };
  expect(r.tools).toHaveLength(1);
  expect(r.tools[0]).toMatchObject({ name: 'report_evidence' });
});

it('tools/list → METHOD_NOT_FOUND when no handler', () => {
  const result = handleMessage(
    msg({ jsonrpc: '2.0', id: 21, method: 'tools/list' }),
    makeResolver(),
    SERVER_VERSION,
    // no toolHandler
  );
  expect(result.kind).toBe('error');
  if (result.kind !== 'error') return;
  expect(result.body.error.code).toBe(METHOD_NOT_FOUND);
});

it('tools/call with valid tool → success response', () => {
  const result = handleMessage(
    msg({ jsonrpc: '2.0', id: 22, method: 'tools/call', params: { name: 'report_evidence', arguments: {} } }),
    makeResolver(),
    SERVER_VERSION,
    stubToolHandler,
  );
  expect(result.kind).toBe('response');
  if (result.kind !== 'response') return;
  const r = result.body.result as { content: Array<{ type: string; text: string }>; isError: boolean };
  expect(r.isError).toBe(false);
  expect(r.content[0].text).toBe('Evidence recorded');
});

it('tools/call with unknown tool → isError response', () => {
  const result = handleMessage(
    msg({ jsonrpc: '2.0', id: 23, method: 'tools/call', params: { name: 'unknown', arguments: {} } }),
    makeResolver(),
    SERVER_VERSION,
    stubToolHandler,
  );
  expect(result.kind).toBe('response');
  if (result.kind !== 'response') return;
  const r = result.body.result as { isError: boolean };
  expect(r.isError).toBe(true);
});

it('tools/call without name param → INVALID_PARAMS', () => {
  const result = handleMessage(
    msg({ jsonrpc: '2.0', id: 24, method: 'tools/call', params: {} }),
    makeResolver(),
    SERVER_VERSION,
    stubToolHandler,
  );
  expect(result.kind).toBe('error');
  if (result.kind !== 'error') return;
  expect(result.body.error.code).toBe(INVALID_PARAMS);
});

it('initialize advertises tools capability when handler present', () => {
  const result = handleMessage(
    msg({ jsonrpc: '2.0', id: 25, method: 'initialize' }),
    makeResolver(),
    SERVER_VERSION,
    stubToolHandler,
  );
  expect(result.kind).toBe('response');
  if (result.kind !== 'response') return;
  const r = result.body.result as { capabilities: { tools?: object } };
  expect(r.capabilities.tools).toEqual({});
});

it('initialize omits tools capability when no handler', () => {
  const result = handleMessage(
    msg({ jsonrpc: '2.0', id: 26, method: 'initialize' }),
    makeResolver(),
    SERVER_VERSION,
  );
  expect(result.kind).toBe('response');
  if (result.kind !== 'response') return;
  const r = result.body.result as { capabilities: Record<string, unknown> };
  expect(r.capabilities).not.toHaveProperty('tools');
});
```

Update existing test at line 111-120 (`tools/list → METHOD_NOT_FOUND`) — it still passes as-is because no `toolHandler` is passed in the existing tests.

## Acceptance Criteria

1. `tools/list` returns all 5 tool definitions when `toolHandler` is provided
2. `tools/list` returns `METHOD_NOT_FOUND` when no `toolHandler` (backward compatible)
3. `tools/call` dispatches to the correct handler and returns MCP-compliant result
4. `report_evidence` appends evidence to the ledger without duplicates
5. `report_progress` records progress as observed evidence
6. `mark_task_done` sets status=done, method=mcp-tool, records files and evidence, recomputes summary
7. `report_validation_result` appends a validation entry matching the existing `EvidenceValidationEntry` schema
8. `report_error` sets status=failed, records error and recoverability, recomputes summary
9. Invalid input returns structured error without side effects
10. Nonexistent session/task returns descriptive error
11. `initialize` advertises `tools` capability when handler is present
12. All existing handler tests still pass (backward compatible — `toolHandler` is optional)
13. Auth is unchanged — same Bearer token protects both resources and tools
14. No writes outside `.diptych/sessions/$sessionId/evidence.json`
15. `npm run test-ci` passes with all new tests

## Implementation Order

1. Add `McpToolDefinition` to `src/engine/mcp/types.ts`
2. Create `src/engine/mcp/tool-schemas.ts` with Zod schemas
3. Create `src/engine/mcp/tool-handler.ts` with handler + all 5 tools
4. Add `'mcp-tool'` to `TaskCompletionMethodSchema` in `src/core/schemas/enums.ts`
5. Update `src/engine/mcp/handlers.ts` — add `tools/list` + `tools/call` + advertise capability
6. Update `src/engine/mcp/server.ts` — pass `toolHandler` through
7. Wire in `src/cli/commands/mcp.ts`
8. Create `src/engine/mcp/tool-handler.test.ts`
9. Update `src/engine/mcp/handlers.test.ts`
10. Run `npm run test-ci`

## Non-Goals

- **Event bus integration.** Tool calls do not publish to the EventBus. The orchestrator reads evidence from disk. If live events are needed later, add a thin bus publish wrapper — but not in v1.
- **State machine mutations.** Tools write evidence only. The orchestrator owns state transitions.
- **Streaming responses.** All tool calls are synchronous request/response.
- **Rate limiting.** Handled at the transport layer if needed; not in tool handler.
- **Tool subscriptions / notifications.** Not in MCP tools spec; not needed.
