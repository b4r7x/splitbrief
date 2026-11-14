import { revisionsMatch } from '../../../lib/fs/atomic-write/revision.js';
import type { ConfigRevision } from '../../../lib/fs/atomic-write/types.js';
import type { StateOperationConflictData, StateOperationExpectedRevision } from './errors.js';
import type { StateHead } from './head.js';

type ExpectedIdentity = Readonly<{
  stateRevision: number | null;
  rawRevision: ConfigRevision | null;
  missing: boolean;
}>;

export function expectedIdentity(
  expected: StateOperationExpectedRevision | undefined,
): ExpectedIdentity {
  if (expected === undefined) {
    return {
      stateRevision: null,
      rawRevision: null,
      missing: false,
    };
  }
  if (expected === null) {
    return { stateRevision: null, rawRevision: null, missing: true };
  }
  if (typeof expected === 'number') {
    return { stateRevision: expected, rawRevision: null, missing: false };
  }
  return { stateRevision: null, rawRevision: expected, missing: false };
}

export function observedRevision(head: StateHead | null): number | null {
  return head?.state.stateRevision ?? null;
}

function currentStateRevision(head: StateHead | null): number {
  return head?.state.stateRevision ?? 0;
}

export function conflictData(
  operation: StateOperationConflictData['operation'],
  expected: ExpectedIdentity,
  head: StateHead | null,
  attempts: number,
  retryLimit: number,
): StateOperationConflictData {
  return {
    operation,
    expectedRevision: expected.stateRevision,
    observedRevision: observedRevision(head),
    attempts,
    retryLimit,
  };
}

export function expectedConflicts(expected: ExpectedIdentity, head: StateHead | null): boolean {
  if (expected.missing && head !== null) return true;
  if (expected.stateRevision !== null && expected.stateRevision !== currentStateRevision(head)) {
    return true;
  }
  if (
    expected.rawRevision !== null &&
    (head === null || !revisionsMatch(expected.rawRevision, head.revision))
  ) {
    return true;
  }
  return false;
}
