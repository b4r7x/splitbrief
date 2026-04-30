import { existsSync } from 'node:fs';
import type { TaskId } from '../../core/schemas/task.js';
import type { EvidenceLedger, EvidenceValidationEntry } from '../../core/schemas/evidence.js';
import { sessionDir, sessionsRoot } from '../../core/paths.js';
import { assertPathConfined } from '../../lib/path-confinement.js';
import {
  readEvidenceLedger,
  writeEvidenceLedger,
} from '../orchestrator/evidence.js';
import type { McpToolDefinition } from './types.js';
import {
  MarkTaskDoneInputSchema,
  ReportErrorInputSchema,
  ReportEvidenceInputSchema,
  ReportProgressInputSchema,
  ReportValidationResultInputSchema,
} from './tool-schemas.js';

export type ToolCallResult =
  | { ok: true; content: string }
  | { ok: false; error: string };

export type McpToolHandler = {
  listTools(): McpToolDefinition[];
  callTool(name: string, args: Record<string, unknown>): ToolCallResult;
};

type EvidenceTask = EvidenceLedger['tasks'][number];

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

function invalidInput(issues: Array<{ message: string }>): ToolCallResult {
  return { ok: false, error: `Invalid input: ${issues.map(issue => issue.message).join(', ')}` };
}

function hasUnsafeSessionPathSegment(sessionId: string): boolean {
  return sessionId
    .split(/[\\/]+/)
    .some(segment => segment.length === 0 || segment === '.' || segment === '..');
}

function assertSessionConfined(projectDir: string, sessionId: string): string | null {
  if (hasUnsafeSessionPathSegment(sessionId)) {
    return `unsafe session ID: ${sessionId}`;
  }
  try {
    assertPathConfined(sessionId, sessionsRoot(projectDir));
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : `unsafe session ID: ${sessionId}`;
  }
}

function assertSessionExists(projectDir: string, sessionId: string): string | null {
  const dir = sessionDir(projectDir, sessionId);
  if (!existsSync(dir)) return `Session not found: ${sessionId}`;
  return null;
}

function assertTaskExists(ledger: EvidenceLedger | null, taskId: TaskId): string | null {
  if (ledger === null) return 'Evidence ledger not found for this session';
  if (!ledger.tasks.some(task => task.id === taskId)) {
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
): EvidenceTask | null {
  return ledger.tasks.find(task => task.id === taskId) ?? null;
}

function replaceLedgerTask(
  ledger: EvidenceLedger,
  updated: EvidenceTask,
): EvidenceLedger {
  const tasks = ledger.tasks.map(task => (task.id === updated.id ? updated : task));
  return {
    ...ledger,
    tasks,
    generatedAt: new Date().toISOString(),
  };
}

function readCheckedLedger(
  projectDir: string,
  sessionId: string,
  taskId: TaskId,
): { ok: true; ledger: EvidenceLedger; task: EvidenceTask } | { ok: false; error: string } {
  const sessionConfinedError = assertSessionConfined(projectDir, sessionId);
  if (sessionConfinedError !== null) return { ok: false, error: sessionConfinedError };

  const sessionError = assertSessionExists(projectDir, sessionId);
  if (sessionError !== null) return { ok: false, error: sessionError };

  const ledger = readEvidenceLedger(projectDir, sessionId);
  const taskError = assertTaskExists(ledger, taskId);
  if (taskError !== null) return { ok: false, error: taskError };
  if (ledger === null) return { ok: false, error: 'Evidence ledger not found for this session' };

  const task = findOrCreateTask(ledger, taskId);
  if (task === null) return { ok: false, error: `Task not found in evidence ledger: ${taskId}` };

  return { ok: true, ledger, task };
}

function handleReportEvidence(
  projectDir: string,
  args: Record<string, unknown>,
): ToolCallResult {
  const parsed = ReportEvidenceInputSchema.safeParse(args);
  if (!parsed.success) return invalidInput(parsed.error.issues);

  const { sessionId, taskId, observedEvidence, changedFiles } = parsed.data;
  const loaded = readCheckedLedger(projectDir, sessionId, taskId);
  if (!loaded.ok) return loaded;

  const updated: EvidenceTask = {
    ...loaded.task,
    observedEvidence: [...loaded.task.observedEvidence],
    changedFiles: [...loaded.task.changedFiles],
  };
  for (const evidence of observedEvidence) uniquePush(updated.observedEvidence, evidence);
  for (const file of changedFiles ?? []) uniquePush(updated.changedFiles, file);

  writeEvidenceLedger(projectDir, sessionId, replaceLedgerTask(loaded.ledger, updated));
  return { ok: true, content: `Recorded ${observedEvidence.length} evidence item(s) for ${taskId}` };
}

function handleReportProgress(
  projectDir: string,
  args: Record<string, unknown>,
): ToolCallResult {
  const parsed = ReportProgressInputSchema.safeParse(args);
  if (!parsed.success) return invalidInput(parsed.error.issues);

  const { sessionId, taskId, message, percentComplete } = parsed.data;
  const loaded = readCheckedLedger(projectDir, sessionId, taskId);
  if (!loaded.ok) return loaded;

  const progressEntry = percentComplete !== undefined
    ? `progress: ${message} (${percentComplete}%)`
    : `progress: ${message}`;

  const updated: EvidenceTask = {
    ...loaded.task,
    observedEvidence: [...loaded.task.observedEvidence],
  };
  uniquePush(updated.observedEvidence, progressEntry);

  writeEvidenceLedger(projectDir, sessionId, replaceLedgerTask(loaded.ledger, updated));
  return { ok: true, content: `Progress recorded for ${taskId}: ${message}` };
}

function handleMarkTaskDone(
  projectDir: string,
  args: Record<string, unknown>,
): ToolCallResult {
  const parsed = MarkTaskDoneInputSchema.safeParse(args);
  if (!parsed.success) return invalidInput(parsed.error.issues);

  const { sessionId, taskId, changedFiles, observedEvidence, summary } = parsed.data;
  const loaded = readCheckedLedger(projectDir, sessionId, taskId);
  if (!loaded.ok) return loaded;

  const updated: EvidenceTask = {
    ...loaded.task,
    status: 'done',
    method: 'mcp-tool',
    changedFiles: [...loaded.task.changedFiles],
    observedEvidence: [...loaded.task.observedEvidence],
  };

  for (const file of changedFiles) uniquePush(updated.changedFiles, file);
  uniquePush(updated.observedEvidence, 'task reached done');
  if (summary !== undefined) uniquePush(updated.observedEvidence, `summary: ${summary}`);
  for (const evidence of observedEvidence ?? []) uniquePush(updated.observedEvidence, evidence);

  const updatedLedger = replaceLedgerTask(loaded.ledger, updated);
  writeEvidenceLedger(projectDir, sessionId, {
    ...updatedLedger,
    validationSummary: recomputeValidationSummary(updatedLedger.tasks),
  });
  return { ok: true, content: `Task ${taskId} marked done. ${changedFiles.length} file(s) recorded.` };
}

function handleReportValidationResult(
  projectDir: string,
  args: Record<string, unknown>,
): ToolCallResult {
  const parsed = ReportValidationResultInputSchema.safeParse(args);
  if (!parsed.success) return invalidInput(parsed.error.issues);

  const { sessionId, taskId, stage, passed, errorSummary, changedFiles } = parsed.data;
  const loaded = readCheckedLedger(projectDir, sessionId, taskId);
  if (!loaded.ok) return loaded;

  const entry: EvidenceValidationEntry = { stage, passed };
  if (!passed && errorSummary !== undefined) entry.errorSummary = errorSummary;
  if (changedFiles !== undefined && changedFiles.length > 0) {
    entry.changedFiles = [...changedFiles];
  }

  const updated: EvidenceTask = {
    ...loaded.task,
    validation: [...loaded.task.validation, entry],
    observedEvidence: [...loaded.task.observedEvidence],
    changedFiles: [...loaded.task.changedFiles],
  };

  if (passed) uniquePush(updated.observedEvidence, `${stage} passed`);
  for (const file of changedFiles ?? []) uniquePush(updated.changedFiles, file);

  writeEvidenceLedger(projectDir, sessionId, replaceLedgerTask(loaded.ledger, updated));
  const statusLabel = passed ? 'passed' : 'failed';
  return { ok: true, content: `Validation ${stage} ${statusLabel} for ${taskId}` };
}

function handleReportError(
  projectDir: string,
  args: Record<string, unknown>,
): ToolCallResult {
  const parsed = ReportErrorInputSchema.safeParse(args);
  if (!parsed.success) return invalidInput(parsed.error.issues);

  const { sessionId, taskId, error, changedFiles, recoverable } = parsed.data;
  const loaded = readCheckedLedger(projectDir, sessionId, taskId);
  if (!loaded.ok) return loaded;

  const updated: EvidenceTask = {
    ...loaded.task,
    status: 'failed',
    observedEvidence: [...loaded.task.observedEvidence],
    changedFiles: [...loaded.task.changedFiles],
  };

  uniquePush(updated.observedEvidence, `error: ${error}`);
  if (recoverable === true) uniquePush(updated.observedEvidence, 'agent reports: recoverable');
  if (recoverable === false) uniquePush(updated.observedEvidence, 'agent reports: unrecoverable');
  for (const file of changedFiles ?? []) uniquePush(updated.changedFiles, file);

  const updatedLedger = replaceLedgerTask(loaded.ledger, updated);
  writeEvidenceLedger(projectDir, sessionId, {
    ...updatedLedger,
    validationSummary: recomputeValidationSummary(updatedLedger.tasks),
  });
  return { ok: true, content: `Error recorded for ${taskId}: ${error}` };
}

function recomputeValidationSummary(
  tasks: EvidenceLedger['tasks'],
): EvidenceLedger['validationSummary'] {
  const summary = { passed: 0, failed: 0, skipped: 0, escalated: 0 };
  for (const task of tasks) {
    if (task.status === 'skipped') {
      summary.skipped += 1;
      continue;
    }
    if (task.status === 'escalated') summary.escalated += 1;
    if (task.status === 'done') {
      summary.passed += 1;
      continue;
    }
    if (task.status === 'failed') summary.failed += 1;
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
