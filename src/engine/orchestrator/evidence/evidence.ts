import { join } from 'node:path';
import type { Task, TaskId } from '../../../core/schemas/task.js';
import type { TaskCompletionMethod, TaskStatus, WorkflowMode } from '../../../core/schemas/enums.js';
import type { Summary } from '../../../core/schemas/summary.js';
import type { ValidationResult } from '../validation.js';
import type {
  EvidenceFinalReviewStatus,
  EvidenceApproval,
  EvidenceLedger,
  EvidenceRejection,
  EvidenceTask,
  EvidenceValidationEntry,
} from '../../../core/schemas/evidence.js';
import { EvidenceLedgerSchema } from '../../../core/schemas/evidence.js';
import { EVIDENCE_FILE, REVIEW_FILE, sessionDir } from '../../../core/paths.js';
import { readJsonSafe, writeSecureFile } from '../../../lib/fs.js';

const VALIDATION_PASSED_LABEL: Record<EvidenceValidationEntry['stage'], string> = {
  typecheck: 'typecheck passed',
  lint: 'lint passed',
  test: 'test passed',
};

function nowIso(): string {
  return new Date().toISOString();
}

function clone(ledger: EvidenceLedger): EvidenceLedger {
  return {
    ...ledger,
    tasks: ledger.tasks.map(t => ({
      ...t,
      changedFiles: [...t.changedFiles],
      validation: t.validation.map(v => ({ ...v, ...(v.changedFiles ? { changedFiles: [...v.changedFiles] } : {}) })),
      expectedEvidence: [...t.expectedEvidence],
      observedEvidence: [...t.observedEvidence],
    })),
    validationSummary: { ...ledger.validationSummary },
    ...(ledger.finalReview && { finalReview: { ...ledger.finalReview } }),
    ...(ledger.approvals && { approvals: ledger.approvals.map(a => ({ ...a })) }),
    ...(ledger.rejections && { rejections: ledger.rejections.map(r => ({ ...r })) }),
  };
}

function buildExpectedEvidence(task: Task): string[] {
  const out: string[] = [];
  for (const e of task.evidence ?? []) out.push(e);
  for (const t of task.tests ?? []) out.push(t);
  return out;
}

function emptyEvidenceTask(task: Task): EvidenceTask {
  return {
    id: task.id,
    title: task.title,
    file: task.file,
    status: task.status,
    retries: 0,
    changedFiles: [],
    validation: [],
    expectedEvidence: buildExpectedEvidence(task),
    observedEvidence: [],
    escalated: false,
    briefHash: null,
  };
}

function recomputeValidationSummary(tasks: EvidenceTask[]): EvidenceLedger['validationSummary'] {
  const summary = { passed: 0, failed: 0, skipped: 0, escalated: 0 };
  for (const t of tasks) {
    if (t.status === 'skipped') {
      summary.skipped += 1;
      continue;
    }
    if (t.status === 'escalated') {
      summary.escalated += 1;
    }
    if (t.status === 'done') {
      summary.passed += 1;
      continue;
    }
    if (t.status === 'failed') {
      summary.failed += 1;
    }
  }
  return summary;
}

function replaceTask(ledger: EvidenceLedger, updated: EvidenceTask): EvidenceLedger {
  const next = clone(ledger);
  const idx = next.tasks.findIndex(t => t.id === updated.id);
  if (idx === -1) {
    next.tasks.push(updated);
  } else {
    next.tasks[idx] = updated;
  }
  next.validationSummary = recomputeValidationSummary(next.tasks);
  next.generatedAt = nowIso();
  return next;
}

function findOrSeed(ledger: EvidenceLedger, task: Task, briefHash?: string | null): EvidenceTask {
  const existing = ledger.tasks.find(t => t.id === task.id);
  if (existing) {
    const resolvedHash = (existing.briefHash != null)
      ? existing.briefHash
      : (briefHash ?? null);
    return {
      ...existing,
      title: task.title,
      file: task.file,
      changedFiles: [...existing.changedFiles],
      validation: existing.validation.map(v => ({ ...v, ...(v.changedFiles ? { changedFiles: [...v.changedFiles] } : {}) })),
      expectedEvidence: existing.expectedEvidence.length > 0
        ? [...existing.expectedEvidence]
        : buildExpectedEvidence(task),
      observedEvidence: [...existing.observedEvidence],
      briefHash: resolvedHash,
    };
  }
  return emptyEvidenceTask(task);
}

function uniquePush(arr: string[], value: string): void {
  if (!arr.includes(value)) arr.push(value);
}

function validationEntries(
  results: ValidationResult[],
  metadata?: { retryState?: EvidenceValidationEntry['retryState']; changedFiles?: string[] | undefined } | undefined,
): EvidenceValidationEntry[] {
  return results.map(r => {
    const entry: EvidenceValidationEntry = { stage: r.stage, passed: r.passed };
    if (r.error && !r.passed) entry.errorSummary = r.error.split('\n').slice(0, 5).join('\n');
    if (!r.passed && metadata?.retryState) entry.retryState = metadata.retryState;
    if (!r.passed && metadata?.changedFiles && metadata.changedFiles.length > 0) {
      entry.changedFiles = [...metadata.changedFiles];
    }
    return entry;
  });
}

function appendValidationEntries(target: EvidenceValidationEntry[], entries: EvidenceValidationEntry[]): void {
  for (const entry of entries) {
    target.push({ ...entry, ...(entry.changedFiles ? { changedFiles: [...entry.changedFiles] } : {}) });
  }
}

export type CreateEvidenceLedgerInput = {
  sessionId: string;
  feature: string;
  mode?: WorkflowMode | undefined;
  tasks: Task[];
  briefHash?: string | null;
};

export function createEvidenceLedger(input: CreateEvidenceLedgerInput): EvidenceLedger {
  const bh = input.briefHash ?? null;
  const tasks = input.tasks.map(task => ({ ...emptyEvidenceTask(task), briefHash: bh }));
  const ledger: EvidenceLedger = {
    version: 1,
    sessionId: input.sessionId,
    feature: input.feature,
    generatedAt: nowIso(),
    tasks,
    validationSummary: recomputeValidationSummary(tasks),
    briefHash: bh,
  };
  if (input.mode !== undefined) ledger.mode = input.mode;
  return ledger;
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
};

export function recordLocalTaskEvidence(input: RecordLocalTaskEvidenceInput): EvidenceLedger {
  const next = findOrSeed(input.ledger, input.task, input.briefHash);
  next.briefHash = input.briefHash ?? next.briefHash ?? null;
  next.status = input.status;
  if (input.method) next.method = input.method;
  if (typeof input.retries === 'number') next.retries = input.retries;
  if (typeof input.durationMs === 'number') next.durationMs = input.durationMs;
  for (const file of input.changedFiles ?? [input.task.file]) {
    if (file) uniquePush(next.changedFiles, file);
  }
  next.validation = validationEntries(input.validation, {
    retryState: input.validationRetryState,
    changedFiles: input.changedFiles,
  });
  if (input.status === 'done') uniquePush(next.observedEvidence, 'task reached done');
  for (const r of input.validation) {
    if (r.passed) uniquePush(next.observedEvidence, VALIDATION_PASSED_LABEL[r.stage]);
  }
  if (next.changedFiles.length > 0) {
    uniquePush(next.observedEvidence, `diff written for ${input.task.file}`);
  }
  return replaceTask(input.ledger, next);
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
    appendValidationEntries(next.validation, validationEntries(input.validation, {
      retryState: input.validationRetryState ?? (input.escalated ? 'escalated' : input.status === 'failed' ? 'failed' : 'retry'),
      changedFiles: input.changedFiles,
    }));
  }
  if (input.status === 'done') {
    uniquePush(next.observedEvidence, 'task reached done');
  }
  if (input.escalated || input.status === 'escalated') {
    uniquePush(next.observedEvidence, 'task reached escalated');
  }
  if (input.validation) {
    for (const r of input.validation) {
      if (r.passed) uniquePush(next.observedEvidence, VALIDATION_PASSED_LABEL[r.stage]);
    }
  }
  if ((input.status === 'done' || input.status === 'escalated') && next.changedFiles.length === 0) {
    uniquePush(next.changedFiles, input.task.file);
  }
  if (next.changedFiles.length > 0) {
    uniquePush(next.observedEvidence, `diff written for ${input.task.file}`);
  }
  return replaceTask(input.ledger, next);
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
  return replaceTask(input.ledger, next);
}

export type RecordFinalReviewEvidenceInput = {
  ledger: EvidenceLedger;
  status: EvidenceFinalReviewStatus;
  path?: string | undefined;
};

export function recordFinalReviewEvidence(input: RecordFinalReviewEvidenceInput): EvidenceLedger {
  const next = clone(input.ledger);
  next.finalReview = { path: input.path ?? REVIEW_FILE, status: input.status };
  next.generatedAt = nowIso();
  if (input.status === 'written') {
    for (const t of next.tasks) {
      if (t.status === 'done' || t.status === 'escalated') {
        uniquePush(t.observedEvidence, 'final review written');
      }
    }
  }
  return next;
}

export type RecordRejectionEvidenceInput = {
  ledger: EvidenceLedger;
  tier: 'sticky' | 'confirm';
  actionClass: EvidenceRejection['actionClass'];
  actionDescription: string;
  taskId?: TaskId;
  reason: string;
};

export type RecordApprovalEvidenceInput = {
  ledger: EvidenceLedger;
  tier: 'confirm';
  actionClass: EvidenceApproval['actionClass'];
  actionDescription: string;
  taskId?: TaskId;
  reason: string;
};

export function recordApprovalEvidence(input: RecordApprovalEvidenceInput): EvidenceLedger {
  const next = clone(input.ledger);
  const entry: EvidenceApproval = {
    ts: new Date().toISOString(),
    tier: input.tier,
    actionClass: input.actionClass,
    actionDescription: input.actionDescription,
    ...(input.taskId !== undefined && { taskId: input.taskId }),
    reason: input.reason,
  };
  if (next.approvals === undefined) {
    next.approvals = [entry];
  } else {
    next.approvals.push(entry);
  }
  next.generatedAt = new Date().toISOString();
  return next;
}

export function recordRejectionEvidence(input: RecordRejectionEvidenceInput): EvidenceLedger {
  const next = clone(input.ledger);
  const entry: EvidenceRejection = {
    ts: new Date().toISOString(),
    tier: input.tier,
    actionClass: input.actionClass,
    actionDescription: input.actionDescription,
    ...(input.taskId !== undefined && { taskId: input.taskId }),
    reason: input.reason,
  };
  if (next.rejections === undefined) {
    next.rejections = [entry];
  } else {
    next.rejections.push(entry);
  }
  next.generatedAt = new Date().toISOString();
  return next;
}

export function buildRejectionContext(ledger: EvidenceLedger): string {
  const rejections = ledger.rejections ?? [];
  if (rejections.length === 0) return '';
  const lines = rejections.map(r =>
    `- [${r.tier}] ${r.actionClass}: ${r.actionDescription} (reason: ${r.reason})`,
  );
  return `Previous rejections:\n${lines.join('\n')}\n`;
}

export function buildEvidenceSummary(ledger: EvidenceLedger): NonNullable<Summary['evidenceSummary']> {
  const totalTasks = ledger.tasks.length;
  const tasksWithValidationEvidence = ledger.tasks.filter(
    t => t.validation.some(v => v.passed),
  ).length;
  const escalatedTasks = ledger.tasks.filter(t => t.status === 'escalated' || t.escalated).length;
  const failedTasks = ledger.tasks.filter(t => t.status === 'failed').length;
  const rejectionCount = ledger.rejections?.length ?? 0;
  return {
    path: EVIDENCE_FILE,
    totalTasks,
    tasksWithValidationEvidence,
    escalatedTasks,
    failedTasks,
    rejectionCount,
  };
}

export function evidenceLedgerPath(projectDir: string, sessionId: string): string {
  return join(sessionDir(projectDir, sessionId), EVIDENCE_FILE);
}

export function writeEvidenceLedger(
  projectDir: string,
  sessionId: string,
  ledger: EvidenceLedger,
): void {
  writeSecureFile(
    evidenceLedgerPath(projectDir, sessionId),
    `${JSON.stringify(ledger, null, 2)}\n`,
  );
}

export function readEvidenceLedger(
  projectDir: string,
  sessionId: string,
): EvidenceLedger | null {
  const raw = readJsonSafe(evidenceLedgerPath(projectDir, sessionId));
  if (raw === null) return null;
  const result = EvidenceLedgerSchema.safeParse(raw);
  return result.success ? result.data : null;
}
