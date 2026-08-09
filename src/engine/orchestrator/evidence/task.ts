import type { Task } from '../../../core/schemas/task.js';
import type { TaskCompletionMethod, TaskStatus } from '../../../core/schemas/enums.js';
import type { ValidationResult } from '../validation/result.js';
import type { EvidenceLedger, EvidenceValidationEntry } from '../../../core/schemas/evidence.js';
import { findOrSeed, withUpdatedTask } from '../../../core/evidence/ledger-state.js';
import { uniquePush } from '../../../utils/collections.js';

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
  for (const file of input.changedFiles ?? [input.task.file]) {
    if (file) uniquePush(next.changedFiles, file);
  }
  next.validation = validationEntries(input.validation, {
    retryState: input.validationRetryState,
    changedFiles: input.changedFiles,
    exemptStages: input.exemptStages,
  });
  if (input.status === 'done') uniquePush(next.observedEvidence, 'task reached done');
  for (const r of input.validation) {
    if (r.passed) {
      uniquePush(next.observedEvidence, VALIDATION_PASSED_LABEL[r.stage]);
    } else if (isExemptStage(r.stage, input.exemptStages)) {
      uniquePush(next.observedEvidence, VALIDATION_PRE_EXISTING_LABEL[r.stage]);
    }
  }
  if (next.changedFiles.length > 0) {
    uniquePush(next.observedEvidence, `diff written for ${input.task.file}`);
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
      if (r.passed) {
        uniquePush(next.observedEvidence, VALIDATION_PASSED_LABEL[r.stage]);
      } else if (isExemptStage(r.stage, input.exemptStages)) {
        uniquePush(next.observedEvidence, VALIDATION_PRE_EXISTING_LABEL[r.stage]);
      }
    }
  }
  if (next.changedFiles.length > 0) {
    uniquePush(next.observedEvidence, `diff written for ${input.task.file}`);
  }
  return withUpdatedTask(input.ledger, next.id, () => next);
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
