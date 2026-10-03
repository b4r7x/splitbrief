import { taskFiles, type Task } from '../../../core/schemas/task.js';
import type { TaskCompletionMethod, TaskStatus } from '../../../core/schemas/enums.js';
import type { ValidationResult } from '../validation/result.js';
import type {
  EvidenceApiApply,
  EvidenceLedger,
  EvidencePromotedFile,
  EvidencePromotionAttempt,
  EvidenceTask,
  EvidenceValidationEntry,
} from '../../../core/schemas/evidence.js';
import type { BundleApplyResult } from '../../implementers/file-bundle.js';
import { findOrSeed, withUpdatedTask } from '../../../core/evidence/ledger-state.js';
import { uniquePush } from '../../../utils/collections.js';
import { readEvidenceLedger } from '../../../core/evidence/ledger-storage.js';
import type { SessionRef } from '../../../core/types/session-ref.js';
import { hashTaskBrief } from '../../brief-hash.js';

const VALIDATION_PASSED_LABEL: Record<EvidenceValidationEntry['stage'], string> = {
  typecheck: 'typecheck passed',
  lint: 'lint passed',
  test: 'test passed',
};

const VALIDATION_PRE_EXISTING_LABEL: Record<EvidenceValidationEntry['stage'], string> = {
  typecheck: 'typecheck failed (pre-existing)',
  lint: 'lint failed (pre-existing)',
  test: 'test failed (pre-existing)',
};

function validationSkippedLabel(result: ValidationResult): string {
  const reason = result.skippedReason;
  return reason === undefined ? `${result.stage} skipped` : `${result.stage} skipped (${reason})`;
}

function diffWrittenLabel(task: Task, changedCount: number): string {
  const target = changedCount > 1 ? `${changedCount} files` : task.file;
  return `diff written for ${target}`;
}

/**
 * The §6 receipt for one bundle application: what the response proposed, what
 * landed, and where it stopped. Digests travel, contents do not.
 */
function apiApplyReceipt(result: BundleApplyResult): EvidenceApiApply {
  return {
    callId: result.callId,
    grammar: 'file-bundle-v1',
    status: result.status,
    candidatePaths: [...result.candidatePaths],
    applied: result.applied.map((file) => ({
      path: file.path,
      action: file.action,
      beforeSha256: file.beforeSha256,
      afterSha256: file.afterSha256,
      ...(file.afterMode === undefined ? {} : { afterMode: file.afterMode }),
    })),
    noops: [...result.noops],
    untouched: [...result.untouched],
    ...(result.status === 'partial' || result.status === 'failed'
      ? { failedPath: result.failedPath }
      : {}),
    ...(result.status === 'applied' ? {} : { code: result.code }),
  };
}

/**
 * What a brief actually changed. A recorded application names the files that
 * landed, so the declared targets are the answer only when no application was
 * recorded at all — §6 keeps evidence on the applied set, never the declared one.
 */
function observedChangedFiles(entry: EvidenceTask, task: Task): string[] {
  if (entry.apiApply === undefined) return [...taskFiles(task)];
  if (entry.apiApply.workspacePath !== undefined) return [...entry.changedFiles];
  return entry.apiApply.applied.map((file) => file.path);
}

function provenCreatedPaths(entry: EvidenceTask | undefined): string[] {
  const paths = new Set(entry?.apiCreatedPaths ?? []);
  if (entry?.apiApply?.workspacePath === undefined) {
    for (const file of entry?.apiApply?.applied ?? []) {
      if (file.action === 'create' && file.beforeSha256 === null) paths.add(file.path);
    }
  }
  return [...paths];
}

/** A missing or unreadable receipt proves no ownership, so capture remains fail-closed. */
export function recordedApiCreatedPaths(ref: SessionRef, task: Task): string[] {
  try {
    return provenCreatedPaths(readEvidenceLedger(ref)?.tasks.find((entry) => entry.id === task.id));
  } catch {
    return [];
  }
}

/** Historical receipts can establish prior output, but cannot prove its current contents. */
export function recordedTargetOutput(
  ref: SessionRef,
  task: Task,
): { files: EvidencePromotedFile[]; hasOutput: boolean } {
  try {
    const entry = readEvidenceLedger(ref)?.tasks.find((entry) => entry.id === task.id);
    const hasOutput =
      entry?.promotedBriefHash !== undefined ||
      (entry?.promotedFiles?.length ?? 0) > 0 ||
      (entry?.promotionAttempts ?? []).some((attempt) => attempt.appliedFiles.length > 0) ||
      (entry?.apiApply?.workspacePath === undefined && (entry?.apiApply?.applied.length ?? 0) > 0);
    return {
      files: entry?.promotedBriefHash === hashTaskBrief([task]) ? (entry.promotedFiles ?? []) : [],
      hasOutput,
    };
  } catch {
    return { files: [], hasOutput: false };
  }
}

/** One current owner per path across every task and every target-write path. */
function withTargetWrites(input: {
  ledger: EvidenceLedger;
  task: Task;
  files: EvidencePromotedFile[];
  unknownPaths?: string[] | undefined;
}): EvidenceLedger {
  const { ledger, task, files, unknownPaths = [] } = input;
  if (files.length === 0 && unknownPaths.length === 0) return ledger;
  const hash = hashTaskBrief([task]);
  const latest = [...new Map(files.map((file) => [file.path, file])).values()];
  const replaced = new Set([...latest.map((file) => file.path), ...unknownPaths]);
  return {
    ...ledger,
    tasks: ledger.tasks.map((entry) => {
      if (entry.id === task.id) {
        const previous = entry.promotedBriefHash === hash ? (entry.promotedFiles ?? []) : [];
        const created = provenCreatedPaths(entry);
        for (const file of latest) {
          if (file.created === true) uniquePush(created, file.path);
        }
        return {
          ...entry,
          promotedBriefHash: hash,
          promotedFiles: [...previous.filter((file) => !replaced.has(file.path)), ...latest],
          ...(created.length > 0 ? { apiCreatedPaths: created } : {}),
        };
      }
      if (entry.promotedFiles === undefined) return entry;
      return {
        ...entry,
        promotedFiles: entry.promotedFiles.filter((file) => !replaced.has(file.path)),
      };
    }),
  };
}

function isExemptStage(
  stage: EvidenceValidationEntry['stage'],
  exemptStages: readonly EvidenceValidationEntry['stage'][] | undefined,
): boolean {
  return exemptStages ? exemptStages.includes(stage) : false;
}

export function validationEntries(
  results: ValidationResult[],
  metadata?:
    | {
        retryState?: EvidenceValidationEntry['retryState'];
        changedFiles?: string[] | undefined;
        exemptStages?: readonly EvidenceValidationEntry['stage'][] | undefined;
      }
    | undefined,
): EvidenceValidationEntry[] {
  return results.map((r) => {
    const entry: EvidenceValidationEntry = { stage: r.stage, passed: r.passed };
    // The final review must quote validation output instead of summarising
    // it, so the recorded command and its output are part of the evidence.
    if (r.command !== undefined) entry.command = r.command;
    if (r.output !== undefined && r.output.trim() !== '') entry.output = r.output;
    if (r.error && !r.passed) entry.errorSummary = r.error.split('\n').slice(0, 5).join('\n');
    if (r.skipped === true) {
      entry.skipped = true;
      if (r.skippedReason !== undefined) entry.skippedReason = r.skippedReason;
    }
    if (!r.passed && isExemptStage(r.stage, metadata?.exemptStages)) entry.baselineExempt = true;
    if (metadata?.retryState) entry.retryState = metadata.retryState;
    if (metadata?.changedFiles && metadata.changedFiles.length > 0) {
      entry.changedFiles = [...metadata.changedFiles];
    }
    return entry;
  });
}

export function appendValidationEntries(
  target: EvidenceValidationEntry[],
  entries: EvidenceValidationEntry[],
): void {
  for (const entry of entries) {
    target.push({
      ...entry,
      ...(entry.changedFiles ? { changedFiles: [...entry.changedFiles] } : {}),
    });
  }
}

export type RecordLocalTaskEvidenceInput = {
  ledger: EvidenceLedger;
  task: Task;
  status: TaskStatus;
  method?: TaskCompletionMethod | undefined;
  retries?: number | undefined;
  durationMs?: number | undefined;
  validation: ValidationResult[];
  changedFiles?: string[] | undefined;
  briefHash?: string | null;
  validationRetryState?: EvidenceValidationEntry['retryState'] | undefined;
  exemptStages?: readonly EvidenceValidationEntry['stage'][] | undefined;
};

export function recordLocalTaskEvidence(input: RecordLocalTaskEvidenceInput): EvidenceLedger {
  const next = findOrSeed(input.ledger, input.task, input.briefHash);
  next.briefHash = input.briefHash ?? next.briefHash ?? null;
  next.status = input.status;
  if (input.method) next.method = input.method;
  if (typeof input.retries === 'number') next.retries = input.retries;
  if (typeof input.durationMs === 'number') next.durationMs = input.durationMs;
  for (const file of input.changedFiles ?? observedChangedFiles(next, input.task)) {
    if (file) uniquePush(next.changedFiles, file);
  }
  appendValidationEntries(
    next.validation,
    validationEntries(input.validation, {
      retryState: input.validationRetryState,
      changedFiles: input.changedFiles,
      exemptStages: input.exemptStages,
    }),
  );
  if (input.status === 'done') uniquePush(next.observedEvidence, 'task reached done');
  for (const r of input.validation) {
    if (r.skipped === true) {
      uniquePush(next.observedEvidence, validationSkippedLabel(r));
    } else if (r.passed) {
      uniquePush(next.observedEvidence, VALIDATION_PASSED_LABEL[r.stage]);
    } else if (isExemptStage(r.stage, input.exemptStages)) {
      uniquePush(next.observedEvidence, VALIDATION_PRE_EXISTING_LABEL[r.stage]);
    }
  }
  if (next.changedFiles.length > 0) {
    uniquePush(next.observedEvidence, diffWrittenLabel(input.task, next.changedFiles.length));
  }
  return withUpdatedTask(input.ledger, next.id, () => next);
}

export type RecordRetryOrEscalationEvidenceInput = {
  ledger: EvidenceLedger;
  task: Task;
  status: TaskStatus;
  method?: TaskCompletionMethod | undefined;
  retries?: number | undefined;
  durationMs?: number | undefined;
  validation?: ValidationResult[] | undefined;
  changedFiles?: string[] | undefined;
  escalated: boolean;
  briefHash?: string | null;
  validationRetryState?: EvidenceValidationEntry['retryState'] | undefined;
  exemptStages?: readonly EvidenceValidationEntry['stage'][] | undefined;
};

export function recordRetryOrEscalationEvidence(
  input: RecordRetryOrEscalationEvidenceInput,
): EvidenceLedger {
  const next = findOrSeed(input.ledger, input.task, input.briefHash);
  next.briefHash = input.briefHash ?? next.briefHash ?? null;
  next.status = input.status;
  if (input.method) next.method = input.method;
  if (typeof input.retries === 'number') next.retries = input.retries;
  if (typeof input.durationMs === 'number') next.durationMs = input.durationMs;
  next.escalated = input.escalated || next.escalated;
  for (const file of input.changedFiles ?? []) {
    if (file) uniquePush(next.changedFiles, file);
  }
  if (input.validation) {
    appendValidationEntries(
      next.validation,
      validationEntries(input.validation, {
        retryState:
          input.validationRetryState ??
          (input.escalated ? 'escalated' : input.status === 'failed' ? 'failed' : 'retry'),
        changedFiles: input.changedFiles,
        exemptStages: input.exemptStages,
      }),
    );
  }
  if (input.status === 'done') {
    uniquePush(next.observedEvidence, 'task reached done');
  }
  if (input.escalated || input.status === 'escalated') {
    uniquePush(next.observedEvidence, 'task reached escalated');
  }
  if (input.validation) {
    for (const r of input.validation) {
      if (r.skipped === true) {
        uniquePush(next.observedEvidence, validationSkippedLabel(r));
      } else if (r.passed) {
        uniquePush(next.observedEvidence, VALIDATION_PASSED_LABEL[r.stage]);
      } else if (isExemptStage(r.stage, input.exemptStages)) {
        uniquePush(next.observedEvidence, VALIDATION_PRE_EXISTING_LABEL[r.stage]);
      }
    }
  }
  if (next.changedFiles.length > 0) {
    uniquePush(next.observedEvidence, diffWrittenLabel(input.task, next.changedFiles.length));
  }
  return withUpdatedTask(input.ledger, next.id, () => next);
}

export type RecordPromotionFailureEvidenceInput = {
  ledger: EvidenceLedger;
  task: Task;
  attempt: EvidencePromotionAttempt;
  briefHash?: string | null;
};

export function recordPromotionFailureEvidence(
  input: RecordPromotionFailureEvidenceInput,
): EvidenceLedger {
  const next = findOrSeed(input.ledger, input.task, input.briefHash);
  next.briefHash = input.briefHash ?? next.briefHash ?? null;
  next.status = 'failed';
  next.promotionAttempts = [...(next.promotionAttempts ?? []), input.attempt];
  // The applied prefix is on the target, so it is a changed file of this task
  // whatever the promotion did with the rest.
  for (const applied of input.attempt.appliedFiles) uniquePush(next.changedFiles, applied.path);
  uniquePush(
    next.observedEvidence,
    `promotion failed at ${input.attempt.failedFile} after applying ${input.attempt.appliedFiles.length} file(s)`,
  );
  return withTargetWrites({
    ledger: withUpdatedTask(input.ledger, next.id, () => next),
    task: input.task,
    files: input.attempt.appliedFiles,
    unknownPaths: [input.attempt.failedFile],
  });
}

export type RecordPromotedFilesEvidenceInput = {
  ledger: EvidenceLedger;
  task: Task;
  files: EvidencePromotedFile[];
  briefHash?: string | null;
};

/**
 * What a promotion left on the target, recorded when it lands rather than when the brief ends: an
 * attempt that promoted and then failed validation leaves those bytes to the attempts after it,
 * and a brief parked there needs this record to tell them from an edit made while it was parked.
 */
export function recordPromotedFilesEvidence(
  input: RecordPromotedFilesEvidenceInput,
): EvidenceLedger {
  const next = findOrSeed(input.ledger, input.task, input.briefHash);
  next.briefHash = input.briefHash ?? next.briefHash ?? null;
  return withTargetWrites({
    ledger: withUpdatedTask(input.ledger, next.id, () => next),
    task: input.task,
    files: input.files,
  });
}

function apiApplyLabel(result: BundleApplyResult): string {
  const applied = `${result.applied.length} of ${result.candidatePaths.length} file(s)`;
  if (result.status === 'applied') return `bundle applied ${applied}`;
  if (result.status === 'rejected') return `bundle refused before any write (${result.code})`;
  return `bundle stopped at ${result.failedPath} after applying ${applied} (${result.code})`;
}

export type RecordApiApplyEvidenceInput = {
  ledger: EvidenceLedger;
  task: Task;
  result: BundleApplyResult;
  workspacePath?: string | undefined;
  briefHash?: string | null;
};

/**
 * The durable record of what one bundle response did on disk, written before
 * the attempt's own outcome is decided. Together with promotion receipts, it
 * proves which targets this task created. Without creation proof, a retry
 * within the same dispatch parks a create brief whose anchor now exists.
 */
export function recordApiApplyEvidence(input: RecordApiApplyEvidenceInput): EvidenceLedger {
  const next = findOrSeed(input.ledger, input.task, input.briefHash);
  next.briefHash = input.briefHash ?? next.briefHash ?? null;
  const created = provenCreatedPaths(next);
  next.apiApply = {
    ...apiApplyReceipt(input.result),
    ...(input.workspacePath === undefined ? {} : { workspacePath: input.workspacePath }),
  };
  if (input.workspacePath === undefined) {
    for (const file of next.apiApply.applied) {
      uniquePush(next.changedFiles, file.path);
      if (file.action === 'create' && file.beforeSha256 === null) uniquePush(created, file.path);
    }
  }
  if (created.length > 0) next.apiCreatedPaths = created;
  // An application that stopped mid-bundle leaves the brief failed until
  // recovery moves it: nothing after the failing path was attempted, and the
  // prefix is not undone.
  if (input.result.status === 'partial') next.status = 'failed';
  uniquePush(
    next.observedEvidence,
    `${input.workspacePath === undefined ? '' : 'worker workspace: '}${apiApplyLabel(input.result)}`,
  );
  const updated = withUpdatedTask(input.ledger, next.id, () => next);
  if (input.workspacePath !== undefined) return updated;
  return withTargetWrites({
    ledger: updated,
    task: input.task,
    files: input.result.applied.map((file) => ({
      path: file.path,
      sha256: file.afterSha256,
      mode: file.afterMode ?? null,
    })),
    unknownPaths:
      input.result.status === 'partial' || input.result.status === 'failed'
        ? [input.result.failedPath]
        : [],
  });
}

export type RecordSkippedTaskEvidenceInput = {
  ledger: EvidenceLedger;
  task: Task;
  reason: string;
  briefHash?: string | null;
};

export function recordSkippedTaskEvidence(input: RecordSkippedTaskEvidenceInput): EvidenceLedger {
  const next = findOrSeed(input.ledger, input.task, input.briefHash);
  next.briefHash = input.briefHash ?? next.briefHash ?? null;
  next.status = 'skipped';
  next.method = 'skipped';
  uniquePush(next.observedEvidence, `skipped: ${input.reason}`);
  return withUpdatedTask(input.ledger, next.id, () => next);
}
