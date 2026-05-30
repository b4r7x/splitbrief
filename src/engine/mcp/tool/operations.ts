import { existsSync } from 'node:fs';
import type { TaskId } from '../../../core/schemas/task.js';
import type { EvidenceLedger, EvidenceValidationEntry } from '../../../core/schemas/evidence.js';
import { sessionDir, sessionsRoot } from '../../../core/paths.js';
import { assertPathConfined } from '../../../lib/path-confinement.js';
import {
  readEvidenceLedger,
  writeEvidenceLedger,
  withUpdatedTask,
} from '../../../core/evidence/ledger.js';
import { uniquePush } from '../../../utils/collections.js';
import {
  MarkTaskDoneInputSchema,
  ReportErrorInputSchema,
  ReportEvidenceInputSchema,
  ReportProgressInputSchema,
  ReportValidationResultInputSchema,
} from './schemas.js';
import type { ToolCallResult } from '../types.js';

type EvidenceTask = EvidenceLedger['tasks'][number];

function invalidInput(issues: Array<{ message: string }>): ToolCallResult {
  return { ok: false, error: `Invalid input: ${issues.map((issue) => issue.message).join(', ')}` };
}

function hasUnsafeSessionPathSegment(sessionId: string): boolean {
  return sessionId
    .split(/[\\/]+/)
    .some((segment) => segment.length === 0 || segment === '.' || segment === '..');
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
  if (!ledger.tasks.some((task) => task.id === taskId)) {
    return `Task not found in evidence ledger: ${taskId}`;
  }
  return null;
}

export function readCheckedLedger(
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

  const task = ledger.tasks.find((t) => t.id === taskId);
  if (task === undefined) {
    return { ok: false, error: `Task not found in evidence ledger: ${taskId}` };
  }

  return { ok: true, ledger, task };
}

export function handleReportEvidence(
  projectDir: string,
  args: Record<string, unknown>,
): ToolCallResult {
  const parsed = ReportEvidenceInputSchema.safeParse(args);
  if (!parsed.success) return invalidInput(parsed.error.issues);

  const { sessionId, taskId, observedEvidence, changedFiles } = parsed.data;
  const loaded = readCheckedLedger(projectDir, sessionId, taskId);
  if (!loaded.ok) return loaded;

  writeEvidenceLedger(
    projectDir,
    sessionId,
    withUpdatedTask(loaded.ledger, taskId, (task) => {
      const updated: EvidenceTask = {
        ...task,
        observedEvidence: [...task.observedEvidence],
        changedFiles: [...task.changedFiles],
      };
      for (const evidence of observedEvidence) uniquePush(updated.observedEvidence, evidence);
      for (const file of changedFiles ?? []) uniquePush(updated.changedFiles, file);
      return updated;
    }),
  );
  return {
    ok: true,
    content: `Recorded ${observedEvidence.length} evidence item(s) for ${taskId}`,
  };
}

export function handleReportProgress(
  projectDir: string,
  args: Record<string, unknown>,
): ToolCallResult {
  const parsed = ReportProgressInputSchema.safeParse(args);
  if (!parsed.success) return invalidInput(parsed.error.issues);

  const { sessionId, taskId, message, percentComplete } = parsed.data;
  const loaded = readCheckedLedger(projectDir, sessionId, taskId);
  if (!loaded.ok) return loaded;

  const progressEntry =
    percentComplete !== undefined
      ? `progress: ${message} (${percentComplete}%)`
      : `progress: ${message}`;

  writeEvidenceLedger(
    projectDir,
    sessionId,
    withUpdatedTask(loaded.ledger, taskId, (task) => {
      const updated: EvidenceTask = { ...task, observedEvidence: [...task.observedEvidence] };
      uniquePush(updated.observedEvidence, progressEntry);
      return updated;
    }),
  );
  return { ok: true, content: `Progress recorded for ${taskId}: ${message}` };
}

export function handleMarkTaskDone(
  projectDir: string,
  args: Record<string, unknown>,
): ToolCallResult {
  const parsed = MarkTaskDoneInputSchema.safeParse(args);
  if (!parsed.success) return invalidInput(parsed.error.issues);

  const { sessionId, taskId, changedFiles, observedEvidence, summary } = parsed.data;
  const loaded = readCheckedLedger(projectDir, sessionId, taskId);
  if (!loaded.ok) return loaded;

  writeEvidenceLedger(
    projectDir,
    sessionId,
    withUpdatedTask(loaded.ledger, taskId, (task) => {
      const updated: EvidenceTask = {
        ...task,
        status: 'done',
        method: 'mcp-tool',
        changedFiles: [...task.changedFiles],
        observedEvidence: [...task.observedEvidence],
      };
      for (const file of changedFiles) uniquePush(updated.changedFiles, file);
      uniquePush(updated.observedEvidence, 'task reached done');
      if (summary !== undefined) uniquePush(updated.observedEvidence, `summary: ${summary}`);
      for (const evidence of observedEvidence ?? []) uniquePush(updated.observedEvidence, evidence);
      return updated;
    }),
  );
  return {
    ok: true,
    content: `Task ${taskId} marked done. ${changedFiles.length} file(s) recorded.`,
  };
}

export function handleReportValidationResult(
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

  writeEvidenceLedger(
    projectDir,
    sessionId,
    withUpdatedTask(loaded.ledger, taskId, (task) => {
      const updated: EvidenceTask = {
        ...task,
        validation: [...task.validation, entry],
        observedEvidence: [...task.observedEvidence],
        changedFiles: [...task.changedFiles],
      };
      if (passed) uniquePush(updated.observedEvidence, `${stage} passed`);
      for (const file of changedFiles ?? []) uniquePush(updated.changedFiles, file);
      return updated;
    }),
  );
  const statusLabel = passed ? 'passed' : 'failed';
  return { ok: true, content: `Validation ${stage} ${statusLabel} for ${taskId}` };
}

export function handleReportError(
  projectDir: string,
  args: Record<string, unknown>,
): ToolCallResult {
  const parsed = ReportErrorInputSchema.safeParse(args);
  if (!parsed.success) return invalidInput(parsed.error.issues);

  const { sessionId, taskId, error, changedFiles, recoverable } = parsed.data;
  const loaded = readCheckedLedger(projectDir, sessionId, taskId);
  if (!loaded.ok) return loaded;

  writeEvidenceLedger(
    projectDir,
    sessionId,
    withUpdatedTask(loaded.ledger, taskId, (task) => {
      const updated: EvidenceTask = {
        ...task,
        status: 'failed',
        observedEvidence: [...task.observedEvidence],
        changedFiles: [...task.changedFiles],
      };
      uniquePush(updated.observedEvidence, `error: ${error}`);
      if (recoverable === true) uniquePush(updated.observedEvidence, 'agent reports: recoverable');
      if (recoverable === false) {
        uniquePush(updated.observedEvidence, 'agent reports: unrecoverable');
      }
      for (const file of changedFiles ?? []) uniquePush(updated.changedFiles, file);
      return updated;
    }),
  );
  return { ok: true, content: `Error recorded for ${taskId}: ${error}` };
}
