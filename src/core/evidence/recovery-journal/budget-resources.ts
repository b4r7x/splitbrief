import {
  RecoveryBudgetResourceSchema,
  type RecoveryBudgetResource,
} from '../../schemas/brief-recovery/budget.js';
import type { SessionRef } from '../../types/session-ref.js';
import { error } from '../../../utils/error.js';
import { assertRecoveryIdentifier } from './paths.js';
import type { RecoveryCheckpoint, RecoveryEvidenceRecord, RecoveryEvidenceRef } from './schema.js';
import { readRecoveryArtifact, recoveryReferenceFromPath } from './artifacts.js';
import { readRecoveryJournal, writeRecoveryEvidence } from './journal.js';

export type RecoveryBudgetResourceKind = 'reservation' | 'usage-reconciliation';

export type RecoveryBudgetResourceWriteInput = Readonly<{
  epochId: string;
  operationId: string;
  kind: RecoveryBudgetResourceKind;
  resource: RecoveryBudgetResource;
  after?: RecoveryCheckpoint | null | undefined;
}>;

export type RecoveryBudgetResourceRecord = Readonly<{
  kind: RecoveryBudgetResourceKind;
  resource: RecoveryBudgetResource;
  recordHash: string;
}>;

function assertBudgetResourceRecordState(
  kind: RecoveryBudgetResourceKind,
  resource: RecoveryBudgetResource,
): void {
  if (resource.kind !== 'provider-dependent') {
    throw error(
      'recovery-evidence-storage',
      'recovery budget resources must be provider-dependent without USD',
    );
  }
  if (kind === 'reservation') {
    if (resource.observedUsage !== null || resource.resolvedPricing !== null) {
      throw error(
        'recovery-evidence-storage',
        'a reservation hold cannot carry observed usage or resolved pricing',
      );
    }
    return;
  }
  if (resource.observedUsage === null && resource.resolvedPricing === null) {
    throw error(
      'recovery-evidence-storage',
      'a usage reconciliation must observe usage or resolve pricing',
    );
  }
}

export function persistRecoveryBudgetResource(
  ref: SessionRef,
  input: RecoveryBudgetResourceWriteInput,
): Readonly<{ ref: RecoveryEvidenceRef; record: RecoveryEvidenceRecord }> {
  if (input.kind !== 'reservation' && input.kind !== 'usage-reconciliation') {
    throw error('recovery-evidence-storage', 'invalid recovery budget resource record kind');
  }
  const parsed = RecoveryBudgetResourceSchema.safeParse(input.resource);
  if (!parsed.success) {
    throw error('recovery-evidence-storage', 'recovery budget resource payload is invalid');
  }
  assertBudgetResourceRecordState(input.kind, parsed.data);
  return writeRecoveryEvidence(ref, {
    epochId: input.epochId,
    kind: input.kind,
    operationId: input.operationId,
    payload: parsed.data,
    after: input.after ?? null,
  });
}

export function readRecoveryBudgetResources(
  ref: SessionRef,
  epochId: string,
  operationId: string,
): readonly RecoveryBudgetResourceRecord[] {
  assertRecoveryIdentifier(epochId, 'epoch id');
  assertRecoveryIdentifier(operationId, 'operation id');
  const records: RecoveryBudgetResourceRecord[] = [];
  for (const record of readRecoveryJournal(ref).records) {
    if (
      record.epochId !== epochId ||
      record.operationId !== operationId ||
      (record.kind !== 'reservation' && record.kind !== 'usage-reconciliation')
    ) {
      continue;
    }
    const parsed = RecoveryBudgetResourceSchema.safeParse(
      readRecoveryArtifact(ref, recoveryReferenceFromPath(ref, record.payloadRef)),
    );
    if (!parsed.success) {
      throw error('recovery-evidence-storage', 'recovery budget resource payload is invalid');
    }
    assertBudgetResourceRecordState(record.kind, parsed.data);
    records.push({ kind: record.kind, resource: parsed.data, recordHash: record.recordHash });
  }
  return records;
}
