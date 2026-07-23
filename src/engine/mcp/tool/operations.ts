import { existsSync } from 'node:fs';
import type { TaskId } from '../../../core/schemas/task.js';
import type { EvidenceLedger, EvidenceValidationEntry } from '../../../core/schemas/evidence.js';
import type { SessionRef } from '../../../core/types/session-ref.js';
import { sessionDir, sessionsRoot } from '../../../core/paths.js';
import { assertPathConfined } from '../../../lib/path-confinement.js';
import { mutateEvidenceLedger, readEvidenceLedger } from '../../../core/evidence/ledger-storage.js';
import { withUpdatedTask } from '../../../core/evidence/ledger-state.js';
import { uniquePush } from '../../../utils/collections.js';
import {
  MarkTaskDoneInputSchema,
  ReportErrorInputSchema,
  ReportEvidenceInputSchema,
  ReportProgressInputSchema,
  ReportValidationResultInputSchema,
} from './schemas.js';
import type { ToolCallResult } from '../types.js';
import { evidenceError } from '../../../core/evidence/errors.js';

type EvidenceTask = EvidenceLedger['tasks'][number];

function invalidInput(issues: Array<{ message: string }>): ToolCallResult {
  return { ok: false, error: `Invalid input: ${issues.map((issue) => issue.message).join(', ')}` };
}

function hasUnsafeSessionPathSegment(sessionId: string): boolean {
  return sessionId
    .split(/[\\/]+/)
    .some((segment) => segment.length === 0 || segment === '.' || segment === '..');
}

function assertSessionConfined(ref: SessionRef): string | null {
  if (hasUnsafeSessionPathSegment(ref.sessionId)) {
    return `unsafe session ID: ${ref.sessionId}`;
  }
  try {
    assertPathConfined(ref.sessionId, sessionsRoot(ref.projectDir));
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : `unsafe session ID: ${ref.sessionId}`;
  }
}

function assertSessionExists(ref: SessionRef): string | null {
  const dir = sessionDir(ref.projectDir, ref.sessionId);
  if (!existsSync(dir)) return `Session not found: ${ref.sessionId}`;
  return null;
}

export function readCheckedLedger(opts: {
  ref: SessionRef;
  taskId: TaskId;
}): { ok: true; ledger: EvidenceLedger; task: EvidenceTask } | { ok: false; error: string } {
  const { ref, taskId } = opts;
  const sessionConfinedError = assertSessionConfined(ref);
  if (sessionConfinedError !== null) return { ok: false, error: sessionConfinedError };

  const sessionError = assertSessionExists(ref);
  if (sessionError !== null) return { ok: false, error: sessionError };

  const ledger = readEvidenceLedger(ref);
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
  const ref = { projectDir, sessionId };
  const loaded = readCheckedLedger({ ref, taskId });
  if (!loaded.ok) return loaded;

  mutateEvidenceLedger(ref, (ledger) => {
    if (ledger === null) throw evidenceError.ledgerNotFound();
    return withUpdatedTask(ledger, taskId, (task) => {
      const updated: EvidenceTask = {
        ...task,
        observedEvidence: [...task.observedEvidence],
        changedFiles: [...task.changedFiles],
      };
      for (const evidence of observedEvidence) uniquePush(updated.observedEvidence, evidence);
      for (const file of changedFiles ?? []) uniquePush(updated.changedFiles, file);
      return updated;
    });
  });
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
  const ref = { projectDir, sessionId };
  const loaded = readCheckedLedger({ ref, taskId });
  if (!loaded.ok) return loaded;

  const progressEntry =
    percentComplete !== undefined
      ? `progress: ${message} (${percentComplete}%)`
      : `progress: ${message}`;

  mutateEvidenceLedger(ref, (ledger) => {
    if (ledger === null) throw evidenceError.ledgerNotFound();
    return withUpdatedTask(ledger, taskId, (task) => {
      const updated: EvidenceTask = { ...task, observedEvidence: [...task.observedEvidence] };
      uniquePush(updated.observedEvidence, progressEntry);
      return updated;
    });
  });
  return { ok: true, content: `Progress recorded for ${taskId}: ${message}` };
}

export function handleMarkTaskDone(
  projectDir: string,
  args: Record<string, unknown>,
): ToolCallResult {
  const parsed = MarkTaskDoneInputSchema.safeParse(args);
  if (!parsed.success) return invalidInput(parsed.error.issues);

  const { sessionId, taskId, changedFiles, observedEvidence, summary } = parsed.data;
  const ref = { projectDir, sessionId };
  const loaded = readCheckedLedger({ ref, taskId });
  if (!loaded.ok) return loaded;

  mutateEvidenceLedger(ref, (ledger) => {
    if (ledger === null) throw evidenceError.ledgerNotFound();
    return withUpdatedTask(ledger, taskId, (task) => {
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
    });
  });
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
  const ref = { projectDir, sessionId };
  const loaded = readCheckedLedger({ ref, taskId });
  if (!loaded.ok) return loaded;

  const entry: EvidenceValidationEntry = { stage, passed };
  if (!passed && errorSummary !== undefined) entry.errorSummary = errorSummary;
  if (changedFiles !== undefined && changedFiles.length > 0) {
    entry.changedFiles = [...changedFiles];
  }

  mutateEvidenceLedger(ref, (ledger) => {
    if (ledger === null) throw evidenceError.ledgerNotFound();
    return withUpdatedTask(ledger, taskId, (task) => {
      const updated: EvidenceTask = {
        ...task,
        validation: [...task.validation, entry],
        observedEvidence: [...task.observedEvidence],
        changedFiles: [...task.changedFiles],
      };
      if (passed) uniquePush(updated.observedEvidence, `${stage} passed`);
      for (const file of changedFiles ?? []) uniquePush(updated.changedFiles, file);
      return updated;
    });
  });
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
  const ref = { projectDir, sessionId };
  const loaded = readCheckedLedger({ ref, taskId });
  if (!loaded.ok) return loaded;

  mutateEvidenceLedger(ref, (ledger) => {
    if (ledger === null) throw evidenceError.ledgerNotFound();
    return withUpdatedTask(ledger, taskId, (task) => {
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
    });
  });
  return { ok: true, content: `Error recorded for ${taskId}: ${error}` };
}
