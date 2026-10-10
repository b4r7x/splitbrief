import { describe, it, expect } from 'vitest';
import { makeReviewPacket } from '#testing/helpers/factories/review-packet.js';
import { makeTask } from '#testing/helpers/factories/task.js';
import { createInitialState } from '../../../../core/state/machine.js';
import { createEvidenceLedger } from '../../../../core/evidence/ledger-state.js';
import type { EvidenceLedger } from '../../../../core/schemas/evidence.js';
import { taskId } from '../../../../core/schemas/task.js';
import type { WorkflowState } from '../../../../core/schemas/workflow.js';
import { buildChanges, buildChecks, buildRun, buildValidation } from './sections.js';
import { renderReviewPacketMarkdown } from './render.js';
import { makeSummary } from '#testing/helpers/factories/summary.js';

function stateWith(...tasks: ReturnType<typeof makeTask>[]): WorkflowState {
  return { ...createInitialState('feat'), tasks };
}

function ledgerFor(task: ReturnType<typeof makeTask>): EvidenceLedger {
  return createEvidenceLedger({ sessionId: 's', feature: 'feat', tasks: [task] });
}

describe('buildValidation baselineExempt carry-through', () => {
  it('carries the baselineExempt flag from the ledger entry and omits it when absent', () => {
    const task = makeTask({ id: 'T001' });
    const base = ledgerFor(task);
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
          },
        ],
        finalReviewEvidenceStatus: null,
      },
    });

    const rendered = renderReviewPacketMarkdown(packet);

    expect(rendered).toContain('T001 done: 1/2 validation stages passed');
    expect(rendered).toContain('1 baseline-exempt: lint');
  });
});

describe('buildChecks', () => {
  it('lists the ledger checks and the isolation outside-read paths', () => {
    const task = makeTask({ id: 'T001' });
    const base = createEvidenceLedger({ sessionId: 's', feature: 'feat', tasks: [task] });
    const ledger: EvidenceLedger = {
      ...base,
      tasks: base.tasks.map((entry) => ({
        ...entry,
        checks: [
          {
            id: 'K1',
            command: 'npm test',
            exitCode: 0,
            output: 'ok',
            artifacts: [{ path: '/tmp/shot.png', sha256: 'abc' }],
            workspaceSnapshotId: 'snap-1',
            ts: '2026-01-01T00:00:00.000Z',
          },
        ],
      })),
    };
    const checks = buildChecks({
      ledger,
      events: [
        {
          ts: '2026-01-01T00:00:00.000Z',
          type: 'warning',
          taskId: taskId('T001'),
          code: 'isolation_outside_read',
          message: 'Task T001 searched ~ with run_command: find ~ -name x',
        },
      ],
    });

    expect(checks.entries).toEqual([
      {
        taskId: 'T001',
        id: 'K1',
        command: 'npm test',
        exitCode: 0,
        output: 'ok',
        artifacts: [{ path: '/tmp/shot.png', sha256: 'abc' }],
        workspaceSnapshotId: 'snap-1',
        ts: '2026-01-01T00:00:00.000Z',
      },
    ]);
    expect(checks.outsideReadPaths).toEqual([
      'Task T001 searched ~ with run_command: find ~ -name x',
    ]);
  });

  it('carries the failures a check showed at the run base too', () => {
    const task = makeTask({ id: 'T001' });
    const base = createEvidenceLedger({ sessionId: 's', feature: 'feat', tasks: [task] });
    const ledger: EvidenceLedger = {
      ...base,
      tasks: base.tasks.map((entry) => ({
        ...entry,
        checks: [
          {
            id: 'test',
            command: 'npm test',
            exitCode: 1,
            preExisting: ['src/legacy.test.ts:5'],
            ts: '2026-01-01T00:00:00.000Z',
          },
        ],
      })),
    };

    expect(buildChecks({ ledger, events: [] }).entries[0]).toMatchObject({
      id: 'test',
      preExisting: ['src/legacy.test.ts:5'],
    });
  });
});

describe('buildChanges declared files', () => {
  it('task row carries files', () => {
    const task = makeTask({ id: 'T001', suggestedFiles: ['src/a.ts', 'src/a.test.ts'] });

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

  it('fills the reviewer from the recorded summary seat without mixing state fields', () => {
    const run = makeRun(
      makeSummary({
        reviewerTool: 'codex',
        reviewerModel: 'gpt-6.1-sol',
        reviewerKind: 'cli',
      }),
      {
        ...createInitialState('feat'),
        reviewerTool: 'old-endpoint',
        reviewerModel: 'old-model',
        reviewerKind: 'api',
      },
    );

    expect(run.reviewer).toEqual({ tool: 'codex', model: 'gpt-6.1-sol', kind: 'cli' });
  });

  it('takes the recorded reviewer from state when the summary names none', () => {
    const run = makeRun(makeSummary(), {
      ...createInitialState('feat'),
      reviewerTool: 'codex',
      reviewerModel: 'gpt-6.1-sol',
      reviewerKind: 'cli',
    });

    expect(run.reviewer).toEqual({ tool: 'codex', model: 'gpt-6.1-sol', kind: 'cli' });
  });

  it('keeps the reviewer model and kind unknown when the summary names only its tool', () => {
    const run = makeRun(makeSummary({ reviewerTool: 'codex' }), {
      ...createInitialState('feat'),
      reviewerTool: 'old-endpoint',
      reviewerModel: 'old-model',
      reviewerKind: 'api',
    });

    expect(run.reviewer).toEqual({ tool: 'codex', model: null, kind: null });
  });

  it('names the planner that holds REVIEW when no separate reviewer is recorded', () => {
    const run = makeRun(
      makeSummary({
        plannerTool: 'claude-code',
        plannerModel: 'sonnet',
        plannerKind: 'cli',
      }),
      createInitialState('feat'),
    );

    expect(run.reviewer).toEqual({ tool: 'claude-code', model: 'sonnet', kind: 'cli' });
    expect(renderReviewPacketMarkdown(makeReviewPacket({ run }))).toContain(
      '- Reviewer: claude-code (sonnet)',
    );
  });

  it.each(['complete', 'tool-only'])(
    'uses the planner after switching a configured reviewer to inheritance before resume, with %s planner details',
    (details) => {
      const plannerModel = details === 'complete' ? 'sonnet' : undefined;
      const plannerKind = details === 'complete' ? 'cli' : undefined;
      const run = makeRun(makeSummary({ plannerTool: 'claude-code', plannerModel, plannerKind }), {
        ...createInitialState('feat'),
        plannerTool: 'old-planner',
        plannerModel: 'old-planner-model',
        plannerKind: 'shell',
        reviewerTool: 'old-endpoint',
        reviewerModel: 'old-reviewer-model',
        reviewerKind: 'api',
      });

      expect(run.reviewer).toEqual({
        tool: 'claude-code',
        model: plannerModel ?? null,
        kind: plannerKind ?? null,
      });
      const markdown = renderReviewPacketMarkdown(makeReviewPacket({ run }));
      expect(markdown).toContain('- Reviewer: claude-code');
      expect(markdown).not.toContain('old-endpoint');
    },
  );

  it('keeps REVIEW unknown when neither seat is recorded', () => {
    const run = makeRun(makeSummary(), createInitialState('feat'));

    expect(run.reviewer).toEqual({ tool: null, model: null, kind: null });
    expect(renderReviewPacketMarkdown(makeReviewPacket({ run }))).toContain('- Reviewer: n/a\n');
  });

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
