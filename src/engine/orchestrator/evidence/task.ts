import type { Task } from '../../../core/schemas/task.js';
import type { TaskCompletionMethod, TaskStatus } from '../../../core/schemas/enums.js';
import type { EvidenceLedger, EvidenceTask } from '../../../core/schemas/evidence.js';
import {
  findOrSeed,
  recomputeValidationSummary,
  upsertEvidenceTask,
} from '../../../core/evidence/ledger-state.js';
import { uniquePush } from '../../../utils/collections.js';
import { readEvidenceLedger } from '../../../core/evidence/ledger-storage.js';
import type { SessionRef } from '../../../core/types/session-ref.js';
import { nowIso } from '../../../utils/format/time.js';

/**
 * What a brief actually changed. A recorded application names the files that
 * landed, so the declared targets are the answer only when no application was
 * recorded at all — §6 keeps evidence on the applied set, never the declared one.
 */
function observedChangedFiles(entry: EvidenceTask, task: Task): string[] {
  if (entry.apiApply === undefined) return [...task.suggestedFiles];
  if (entry.apiApply.workspacePath !== undefined) return [...entry.changedFiles];
  return entry.apiApply.applied.map((file) => file.path);
}

/**
 * A reject put `removed` back, so no brief books them any more. A brief that booked one takes its
 * status from `tasks`, the state after the reject: a passed brief it reopened is pending again.
 */
export function recordRejectEvidence(input: {
  ledger: EvidenceLedger;
  removed: readonly string[];
  tasks: readonly Task[];
}): EvidenceLedger {
  const tasks = input.ledger.tasks.map((entry) => {
    const changedFiles = entry.changedFiles.filter((file) => !input.removed.includes(file));
    if (changedFiles.length === entry.changedFiles.length) return entry;
    const status = input.tasks.find((task) => task.id === entry.id)?.status ?? entry.status;
    return { ...entry, status, changedFiles };
  });
  return {
    ...input.ledger,
    tasks,
    validationSummary: recomputeValidationSummary(tasks),
    generatedAt: nowIso(),
  };
}

/**
 * The files of `changed` that no other brief of the run booked. A lineage's start delta also
 * holds the files of every brief that ran while the lineage was open, such as a fix brief
 * between two split children, and those briefs book their own files.
 */
export function unbookedFiles(ref: SessionRef, task: Task, changed: readonly string[]): string[] {
  const booked = new Set(
    (readEvidenceLedger(ref)?.tasks ?? [])
      .filter((entry) => entry.id !== task.id)
      .flatMap((entry) => entry.changedFiles),
  );
  return changed.filter((file) => !booked.has(file));
}

/** Books `files` on the task besides the files it booked, and keeps its status. */
export function recordRemainderEvidence(input: {
  ledger: EvidenceLedger;
  task: Task;
  files: readonly string[];
}): EvidenceLedger {
  const next = findOrSeed(input.ledger, input.task);
  for (const file of input.files) uniquePush(next.changedFiles, file);
  return upsertEvidenceTask(input.ledger, next);
}

export type RecordLocalTaskEvidenceInput = {
  ledger: EvidenceLedger;
  task: Task;
  status: TaskStatus;
  method?: TaskCompletionMethod | undefined;
  retries?: number | undefined;
  durationMs?: number | undefined;
  changedFiles?: string[] | undefined;
};

export function recordLocalTaskEvidence(input: RecordLocalTaskEvidenceInput): EvidenceLedger {
  const next = findOrSeed(input.ledger, input.task);
  next.status = input.status;
  if (input.method) next.method = input.method;
  if (typeof input.retries === 'number') next.retries = input.retries;
  if (typeof input.durationMs === 'number') next.durationMs = input.durationMs;
  for (const file of input.changedFiles ?? observedChangedFiles(next, input.task)) {
    if (file) uniquePush(next.changedFiles, file);
  }
  return upsertEvidenceTask(input.ledger, next);
}

/**
 * A brief cut by a stop books the files it left, not every file an attempt booked: a halt that
 * put an attempt's files back took them out of the run's changes.
 */
export function recordStoppedTaskEvidence(input: {
  ledger: EvidenceLedger;
  task: Task;
  changedFiles: readonly string[];
}): EvidenceLedger {
  const next = findOrSeed(input.ledger, input.task);
  next.status = 'in_progress';
  next.changedFiles = next.changedFiles.filter((file) => input.changedFiles.includes(file));
  for (const file of input.changedFiles) uniquePush(next.changedFiles, file);
  return upsertEvidenceTask(input.ledger, next);
}

export type RecordRetryOrEscalationEvidenceInput = {
  ledger: EvidenceLedger;
  task: Task;
  status: TaskStatus;
  method?: TaskCompletionMethod | undefined;
  retries?: number | undefined;
  durationMs?: number | undefined;
  changedFiles?: string[] | undefined;
  escalated: boolean;
};

export function recordRetryOrEscalationEvidence(
  input: RecordRetryOrEscalationEvidenceInput,
): EvidenceLedger {
  const next = findOrSeed(input.ledger, input.task);
  next.status = input.status;
  if (input.method) next.method = input.method;
  if (typeof input.retries === 'number') next.retries = input.retries;
  if (typeof input.durationMs === 'number') next.durationMs = input.durationMs;
  next.escalated = input.escalated || next.escalated;
  for (const file of input.changedFiles ?? []) {
    if (file) uniquePush(next.changedFiles, file);
  }
  return upsertEvidenceTask(input.ledger, next);
}

export type RecordSkippedTaskEvidenceInput = {
  ledger: EvidenceLedger;
  task: Task;
  reason: string;
  /** The brief's files still changed after its skip took the others back. */
  keptFiles?: readonly string[] | undefined;
  /** The files of its lineage no other brief booked, when the skip closes the lineage. */
  remainderFiles?: readonly string[] | undefined;
};

export function recordSkippedTaskEvidence(input: RecordSkippedTaskEvidenceInput): EvidenceLedger {
  const next = findOrSeed(input.ledger, input.task);
  next.status = 'skipped';
  next.method = 'skipped';
  const keptFiles = input.keptFiles;
  if (keptFiles !== undefined) {
    next.changedFiles = next.changedFiles.filter((file) => keptFiles.includes(file));
  }
  for (const file of input.remainderFiles ?? []) uniquePush(next.changedFiles, file);
  return upsertEvidenceTask(input.ledger, next);
}
