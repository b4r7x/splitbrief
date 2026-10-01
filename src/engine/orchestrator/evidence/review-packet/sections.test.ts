import { describe, it, expect } from 'vitest';
import { makeReviewPacket } from '#testing/helpers/factories/review-packet.js';
import { makeTask } from '#testing/helpers/factories/task.js';
import { createInitialState } from '../../../../core/state/machine.js';
import { createEvidenceLedger } from '../../../../core/evidence/ledger-state.js';
import type { EvidenceLedger } from '../../../../core/schemas/evidence.js';
import { taskId } from '../../../../core/schemas/task.js';
import type { WorkflowState } from '../../../../core/schemas/workflow.js';
import { buildChanges, buildRun, buildValidation } from './sections.js';
import { renderReviewPacketMarkdown } from './render.js';
import { makeSummary } from '#testing/helpers/factories/summary.js';

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
      'T001 expected evidence SPLITBRIEF did not record (informational; SPLITBRIEF records only its own facts; not a failure on its own): handles concurrent writes without corrupting the ledger',
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

describe('buildChanges declared files', () => {
  it('task row carries files', () => {
    const task = makeTask({ id: 'T001', file: 'src/a.ts', files: ['src/a.ts', 'src/a.test.ts'] });

    const changes = buildChanges({
      state: stateWith(task),
      ledger: null,
      drift: null,
      changedFiles: ['src/a.ts', 'src/a.test.ts', 'src/other.ts'],
    });

    expect(changes.taskFiles[0]?.files).toEqual(['src/a.ts', 'src/a.test.ts']);
    expect(changes.taskFiles[0]?.changedFiles).toEqual(['src/a.ts', 'src/a.test.ts']);
    expect(changes.expectedFiles).toEqual(['src/a.test.ts', 'src/a.ts']);
  });
});

describe('buildRun seat identity kinds', () => {
  function makeRun(summary: Parameters<typeof buildRun>[0]['summary'], state: WorkflowState) {
    return buildRun(
      { projectDir: '/tmp/project', sessionId: 's', summary, state, finalReviewStatus: 'written' },
      [],
    );
  }

  it('carries each seat kind from the summary record that named its tool', () => {
    const run = makeRun(
      makeSummary({
        feature: 'feat',
        plannerTool: 'opencode',
        plannerKind: 'api',
        implementerTool: 'claude-code',
        implementerKind: 'cli',
      }),
      createInitialState('feat'),
    );

    expect(run.planner).toEqual({ tool: 'opencode', model: null, kind: 'api' });
    expect(run.implementer).toEqual({ tool: 'claude-code', model: null, kind: 'cli' });
  });

  it('takes a whole legacy seat from the state when the summary names none', () => {
    const run = makeRun(makeSummary({ feature: 'feat' }), {
      ...createInitialState('feat'),
      plannerTool: 'claude-code',
      plannerKind: 'cli',
    });

    expect(run.planner).toEqual({ tool: 'claude-code', model: null, kind: 'cli' });
    expect(run.implementer).toEqual({ tool: null, model: null, kind: null });
  });

  it('keeps a legacy summary tool unknown rather than borrowing another record kind', () => {
    const run = makeRun(makeSummary({ feature: 'feat', plannerTool: 'claude-code' }), {
      ...createInitialState('feat'),
      plannerTool: 'retired-tool',
      plannerKind: 'shell',
    });

    expect(run.planner).toEqual({ tool: 'claude-code', model: null, kind: null });
  });

  it('keeps the planner model unknown when the summary names the tool without a model', () => {
    const run = makeRun(
      makeSummary({ feature: 'feat', plannerTool: 'new-shell', plannerKind: 'shell' }),
      {
        ...createInitialState('feat'),
        plannerTool: 'old-api',
        plannerModel: 'old-model',
        plannerKind: 'api',
      },
    );

    expect(run.planner).toEqual({ tool: 'new-shell', model: null, kind: 'shell' });
  });

  it('keeps the implementer model unknown when the summary names the tool without a model', () => {
    const run = makeRun(
      makeSummary({ feature: 'feat', implementerTool: 'new-shell', implementerKind: 'shell' }),
      {
        ...createInitialState('feat'),
        implementerTool: 'old-api',
        implementerModel: 'old-model',
        implementerKind: 'api',
      },
    );

    expect(run.implementer).toEqual({ tool: 'new-shell', model: null, kind: 'shell' });
  });
});
