import { describe, it, expect } from 'vitest';
import { makeTask } from '#testing/helpers/factories/task.js';
import { createInitialState } from '../../../../core/state/machine.js';
import { createEvidenceLedger } from '../../../../core/evidence/ledger.js';
import type { EvidenceLedger } from '../../../../core/schemas/evidence.js';
import type { WorkflowState } from '../../../../core/schemas/workflow.js';
import { buildValidation } from './sections.js';

function stateWith(...tasks: ReturnType<typeof makeTask>[]): WorkflowState {
  return { ...createInitialState('feat'), tasks };
}

function ledgerWithEvidence(
  task: ReturnType<typeof makeTask>,
  expectedEvidence: string[],
  observedEvidence: string[],
): EvidenceLedger {
  const ledger = createEvidenceLedger({ sessionId: 's', feature: 'feat', tasks: [task] });
  return {
    ...ledger,
    tasks: ledger.tasks.map((entry) => ({ ...entry, expectedEvidence, observedEvidence })),
  };
}

describe('buildValidation missingExpectedEvidence matching', () => {
  it('keeps a long expectation missing when only a terse observed substring is present', () => {
    const task = makeTask({ id: 'T001' });
    const ledger = ledgerWithEvidence(
      task,
      ['handles concurrent writes without corrupting the ledger'],
      ['ledger'],
    );

    const result = buildValidation(stateWith(task), ledger);

    expect(result.tasks[0]?.missingExpectedEvidence).toEqual([
      'handles concurrent writes without corrupting the ledger',
    ]);
    expect(result.missingEvidenceWarnings).toEqual([
      'T001 missing expected evidence: handles concurrent writes without corrupting the ledger',
    ]);
  });

  it('satisfies an expectation only when an observed item contains the full expected text', () => {
    const task = makeTask({ id: 'T001' });
    const ledger = ledgerWithEvidence(
      task,
      ['test passes'],
      ['integration test passes after retry'],
    );

    const result = buildValidation(stateWith(task), ledger);

    expect(result.tasks[0]?.missingExpectedEvidence).toEqual([]);
    expect(result.missingEvidenceWarnings).toEqual([]);
  });
});
