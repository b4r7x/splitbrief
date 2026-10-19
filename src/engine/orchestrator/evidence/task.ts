import type { Task } from '../../../core/schemas/task.js';
import type { TaskCompletionMethod, TaskStatus } from '../../../core/schemas/enums.js';
import type { CheckRunResult } from '../validation/run-checks.js';
import type {
  EvidenceApiApply,
  EvidenceCheckEntry,
  EvidenceLedger,
  EvidencePromotedFile,
  EvidenceTask,
} from '../../../core/schemas/evidence.js';
import type { BundleApplyResult } from '../../implementers/file-bundle.js';
import { findOrSeed, upsertEvidenceTask } from '../../../core/evidence/ledger-state.js';
import { uniquePush } from '../../../utils/collections.js';
import { readEvidenceLedger } from '../../../core/evidence/ledger-storage.js';
import type { SessionRef } from '../../../core/types/session-ref.js';
import { hashTaskBrief } from '../../../core/evidence/brief-hash.js';
import { nowIso } from '../../../utils/format-time.js';

type CheckEntryMeta = {
  workspaceSnapshotId?: string | undefined;
};

function runCheckEntry(run: CheckRunResult, meta: CheckEntryMeta, ts: string): EvidenceCheckEntry {
  const entry: EvidenceCheckEntry = { id: run.checkId, status: run.status, ts };
  if (run.command !== undefined) entry.command = run.command;
  if (run.exitCode !== undefined) entry.exitCode = run.exitCode;
  if (run.output.trim() !== '') entry.output = run.output;
  if (run.base !== undefined) {
    entry.base = {};
    if (run.base.exitCode !== undefined) entry.base.exitCode = run.base.exitCode;
    if (run.base.output.trim() !== '') entry.base.output = run.base.output;
  }
  if (run.preExisting !== undefined && run.preExisting.length > 0) {
    entry.preExisting = [...run.preExisting];
  }
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
  runs?: readonly CheckRunResult[] | undefined;
  workspaceSnapshotId?: string | undefined;
  ts?: string | undefined;
}): EvidenceCheckEntry[] {
  const ts = input.ts ?? nowIso();
  const meta: CheckEntryMeta = { workspaceSnapshotId: input.workspaceSnapshotId };
  return (input.runs ?? []).map((run) => runCheckEntry(run, meta, ts));
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
  if (entry.apiApply === undefined) return [...task.suggestedFiles];
  if (entry.apiApply.workspacePath !== undefined) return [...entry.changedFiles];
  return entry.apiApply.applied.map((file) => file.path);
}

function provenCreatedPaths(
  entry: EvidenceTask | undefined,
  workspacePath?: string | undefined,
): string[] {
  const receipt = entry?.apiApply;
  if (receipt?.workspacePath !== undefined && receipt.workspacePath !== workspacePath) return [];
  const reverted = new Set(receipt?.revertedPaths ?? []);
  const paths = new Set((entry?.apiCreatedPaths ?? []).filter((path) => !reverted.has(path)));
  for (const file of receipt?.applied ?? []) {
    if (file.action === 'create' && file.beforeSha256 === null && !reverted.has(file.path))
      paths.add(file.path);
  }
  return [...paths];
}

/** A restore removes creation proof only for paths the snapshot puts back to absence. */
export function recordApiRevertEvidence(input: {
  ledger: EvidenceLedger;
  workspacePath: string;
  removedPaths: readonly string[];
}): EvidenceLedger {
  const removed = new Set(input.removedPaths);
  return {
    ...input.ledger,
    tasks: input.ledger.tasks.map((entry) => {
      if (entry.apiApply?.workspacePath !== input.workspacePath) return entry;
      return {
        ...entry,
        apiCreatedPaths: provenCreatedPaths(entry, input.workspacePath).filter(
          (path) => !removed.has(path),
        ),
        apiApply: {
          ...entry.apiApply,
          revertedPaths: [...new Set([...(entry.apiApply.revertedPaths ?? []), ...removed])],
        },
      };
    }),
  };
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

export type RecordApiApplyEvidenceInput = {
  ledger: EvidenceLedger;
  task: Task;
  result: BundleApplyResult;
  workspacePath?: string | undefined;
};

/**
 * The durable record of what one bundle response did on disk, written before
 * the attempt's own outcome is decided. Together with promotion receipts, it
 * proves which targets this task created. Without creation proof, a retry
 * within the same dispatch parks a create brief whose anchor now exists.
 */
export function recordApiApplyEvidence(input: RecordApiApplyEvidenceInput): EvidenceLedger {
  const next = findOrSeed(input.ledger, input.task);
  const created = provenCreatedPaths(next, input.workspacePath);
  next.apiApply = {
    ...apiApplyReceipt(input.result),
    ...(input.workspacePath === undefined ? {} : { workspacePath: input.workspacePath }),
  };
  for (const file of next.apiApply.applied) {
    if (input.workspacePath === undefined) uniquePush(next.changedFiles, file.path);
    if (file.action === 'create' && file.beforeSha256 === null) uniquePush(created, file.path);
  }
  if (created.length > 0) next.apiCreatedPaths = created;
  else delete next.apiCreatedPaths;
  // An application that stopped mid-bundle leaves the brief failed until
  // recovery moves it: nothing after the failing path was attempted, and the
  // prefix remains in the receipt even when checkout recovery puts it back.
  if (input.result.status === 'partial') next.status = 'failed';
  const updated = upsertEvidenceTask(input.ledger, next);
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
  /** The brief's files still changed after its skip took the others back. */
  keptFiles?: readonly string[] | undefined;
};

export function recordSkippedTaskEvidence(input: RecordSkippedTaskEvidenceInput): EvidenceLedger {
  const next = findOrSeed(input.ledger, input.task);
  next.status = 'skipped';
  next.method = 'skipped';
  const keptFiles = input.keptFiles;
  if (keptFiles !== undefined) {
    next.changedFiles = next.changedFiles.filter((file) => keptFiles.includes(file));
  }
  return upsertEvidenceTask(input.ledger, next);
}
