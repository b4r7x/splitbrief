import { taskFiles, type Task } from '../../../core/schemas/task.js';
import type { TaskCompletionMethod, TaskStatus } from '../../../core/schemas/enums.js';
import type { ValidationResult } from '../validation/result.js';
import type { CheckRunResult } from '../validation/run-checks.js';
import { boundedOutputTail } from '../validation/stage.js';
import type {
  EvidenceApiApply,
  EvidenceCheckEntry,
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
import { nowIso } from '../../../utils/format-time.js';

type CheckEntryMeta = {
  workspaceSnapshotId?: string | undefined;
};

function stageCheckEntry(
  result: ValidationResult,
  meta: CheckEntryMeta,
  ts: string,
): EvidenceCheckEntry {
  const entry: EvidenceCheckEntry = { id: result.stage, ts };
  if (result.command !== undefined) entry.command = result.command;
  if (result.exitCode !== undefined) entry.exitCode = result.exitCode;
  const diagnostics = result.passed
    ? result.output
    : [result.output, result.error].filter((part) => (part ?? '').trim() !== '').join('\n');
  if (diagnostics !== undefined && diagnostics.trim() !== '') {
    entry.output = boundedOutputTail(diagnostics);
  }
  if (meta.workspaceSnapshotId !== undefined) entry.workspaceSnapshotId = meta.workspaceSnapshotId;
  return entry;
}

function runCheckEntry(run: CheckRunResult, meta: CheckEntryMeta, ts: string): EvidenceCheckEntry {
  const entry: EvidenceCheckEntry = { id: run.checkId, ts };
  if (run.command !== undefined) entry.command = run.command;
  if (run.exitCode !== undefined) entry.exitCode = run.exitCode;
  if (run.output.trim() !== '') entry.output = run.output;
  if (run.artifacts !== undefined && run.artifacts.length > 0) {
    entry.artifacts = run.artifacts.map((artifact) => ({
      path: artifact.path,
      sha256: artifact.sha256,
    }));
  }
  if (meta.workspaceSnapshotId !== undefined) entry.workspaceSnapshotId = meta.workspaceSnapshotId;
  return entry;
}

export function checkEntries(input: {
  validation?: readonly ValidationResult[] | undefined;
  runs?: readonly CheckRunResult[] | undefined;
  workspaceSnapshotId?: string | undefined;
  ts?: string | undefined;
}): EvidenceCheckEntry[] {
  const ts = input.ts ?? nowIso();
  const meta: CheckEntryMeta = { workspaceSnapshotId: input.workspaceSnapshotId };
  return [
    ...(input.validation ?? []).map((result) => stageCheckEntry(result, meta, ts)),
    ...(input.runs ?? []).map((run) => runCheckEntry(run, meta, ts)),
  ];
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

function provenCreatedPaths(
  entry: EvidenceTask | undefined,
  workspacePath?: string | undefined,
): string[] {
  const paths = new Set(entry?.apiCreatedPaths ?? []);
  const receipt = entry?.apiApply;
  if (receipt?.workspacePath === undefined || receipt.workspacePath === workspacePath) {
    const reverted = new Set(receipt?.revertedPaths ?? []);
    for (const file of receipt?.applied ?? []) {
      if (file.action === 'create' && file.beforeSha256 === null && !reverted.has(file.path))
        paths.add(file.path);
    }
  }
  return [...paths];
}

/** A checkout recovery put the receipt's applied files back, so they prove no creation. */
export function recordApiRevertEvidence(input: {
  ledger: EvidenceLedger;
  task: Task;
}): EvidenceLedger {
  return withUpdatedTask(input.ledger, input.task.id, (entry) =>
    entry.apiApply === undefined
      ? entry
      : {
          ...entry,
          apiApply: {
            ...entry.apiApply,
            revertedPaths: entry.apiApply.applied.map((file) => file.path),
          },
        },
  );
}

/**
 * A missing or unreadable receipt proves no ownership, so capture remains fail-closed. A receipt
 * written in the run workspace proves what the task created there.
 */
export function recordedApiCreatedPaths(
  ref: SessionRef,
  task: Task,
  workspacePath: string,
): string[] {
  try {
    return provenCreatedPaths(
      readEvidenceLedger(ref)?.tasks.find((entry) => entry.id === task.id),
      workspacePath,
    );
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
  // prefix remains in the receipt even when checkout recovery puts it back.
  if (input.result.status === 'partial') next.status = 'failed';
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
  return withUpdatedTask(input.ledger, next.id, () => next);
}
