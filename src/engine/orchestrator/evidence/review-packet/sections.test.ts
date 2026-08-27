import { describe, it, expect } from 'vitest';
import { makeReviewPacket } from '#testing/helpers/factories/review-packet.js';
import { makeTask } from '#testing/helpers/factories/task.js';
import { createInitialState } from '../../../../core/state/machine.js';
import { createEvidenceLedger } from '../../../../core/evidence/ledger-state.js';
import type { EvidenceLedger } from '../../../../core/schemas/evidence.js';
import { taskId } from '../../../../core/schemas/task.js';
import type { WorkflowState } from '../../../../core/schemas/workflow.js';
import { buildValidation } from './sections.js';
import { renderReviewPacketMarkdown } from './render.js';

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

describe('buildValidation baselineExempt carry-through', () => {
  it('carries the baselineExempt flag from the ledger entry and omits it when absent', () => {
    const task = makeTask({ id: 'T001' });
    const base = ledgerWithEvidence(task, [], []);
    const ledger: EvidenceLedger = {
      ...base,
      tasks: base.tasks.map((entry) => ({
        ...entry,
        validation: [
          { stage: 'typecheck', passed: false, baselineExempt: true },
          { stage: 'lint', passed: true },
        ],
      })),
    };

    const result = buildValidation(stateWith(task), ledger);

    expect(result.tasks[0]?.validation).toEqual([
      { stage: 'typecheck', passed: false, baselineExempt: true },
      { stage: 'lint', passed: true },
    ]);
  });

  it('keeps the raw passed count and names the exempt stage in the rendered packet', () => {
    const packet = makeReviewPacket({
      validation: {
        summary: { passed: 1, failed: 1, skipped: 0, escalated: 0 },
        tasks: [
          {
            taskId: taskId('T001'),
            title: 'Add feature',
            status: 'done',
            validation: [
              { stage: 'typecheck', passed: true },
              { stage: 'lint', passed: false, baselineExempt: true },
            ],
            expectedEvidence: [],
            observedEvidence: [],
            missingExpectedEvidence: [],
          },
        ],
        finalReviewEvidenceStatus: null,
        missingEvidenceWarnings: [],
      },
    });

    const rendered = renderReviewPacketMarkdown(packet);

    expect(rendered).toContain('T001 done: 1/2 validation stages passed');
    expect(rendered).toContain('1 baseline-exempt: lint');
  });
});
