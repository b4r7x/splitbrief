import { describe, it, expect } from 'vitest';
import { makeReviewPacket } from '#testing/helpers/factories/review-packet.js';
import { makeTask } from '#testing/helpers/factories/task.js';
import { createInitialState } from '../../../../core/state/machine.js';
import { createEvidenceLedger } from '../../../../core/evidence/ledger-state.js';
import type { EvidenceLedger } from '../../../../core/schemas/evidence.js';
import { taskId } from '../../../../core/schemas/task.js';
import type { WorkflowState } from '../../../../core/schemas/workflow/state.js';
import { buildChanges, buildChecks, buildValidation } from './sections.js';
import { renderReviewPacketMarkdown } from './render.js';
import { renderWholeChecksLog } from './checks-log.js';
import { NULL_CACHE } from '../../../providers/model/runtime-snapshot.js';

function stateWith(...tasks: ReturnType<typeof makeTask>[]): WorkflowState {
  return { ...createInitialState('feat'), tasks };
}

function ledgerFor(task: ReturnType<typeof makeTask>): EvidenceLedger {
  return createEvidenceLedger({ sessionId: 's', feature: 'feat', tasks: [task] });
}

describe('buildValidation', () => {
  it("lists each brief's own check results and leaves out the plan checks booked on the last brief", () => {
    const first = makeTask({
      id: 'T001',
      checkResults: [
        { id: 'T001-K1', status: 'pass' },
        { id: 'T001-K2', status: 'fail' },
      ],
    });
    const last = makeTask({
      id: 'T002',
      checkResults: [
        { id: 'T002-K1', status: 'pass' },
        { id: 'K1', status: 'pass' },
      ],
    });
    const state: WorkflowState = {
      ...stateWith(first, last),
      plan: {
        summary: 'Plan',
        decisions: [],
        criteria: [],
        checks: [{ id: 'K1', kind: 'cmd', value: 'npm test' }],
        validation: null,
      },
    };

    const result = buildValidation(state, ledgerFor(first));

    expect(result.tasks.map((task) => [task.taskId, task.checks])).toEqual([
      [
        'T001',
        [
          { id: 'T001-K1', status: 'pass' },
          { id: 'T001-K2', status: 'fail' },
        ],
      ],
      ['T002', [{ id: 'T002-K1', status: 'pass' }]],
    ]);
  });

  it('spells each brief line from its own checks in the words of the plain output', () => {
    const packet = makeReviewPacket({
      validation: {
        summary: { passed: 2, failed: 0, skipped: 0, escalated: 0 },
        tasks: [
          {
            taskId: taskId('T001'),
            title: 'Add feature',
            status: 'done',
            checks: [
              { id: 'T001-K1', status: 'pass' },
              { id: 'T001-K2', status: 'pass' },
            ],
          },
          { taskId: taskId('T002'), title: 'Wire feature', status: 'done', checks: [] },
        ],
        finalReviewEvidenceStatus: null,
      },
    });

    const rendered = renderReviewPacketMarkdown(packet, NULL_CACHE);

    expect(rendered).toContain('- T001 done: 2 of 2 checks passed');
    expect(rendered).toContain('- T002 done: no checks');
    expect(rendered).not.toContain('validation stages passed');
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

  it('lists the checks a review ran to verify its claims, with no task', () => {
    const task = makeTask({ id: 'T001' });
    const base = createEvidenceLedger({ sessionId: 's', feature: 'feat', tasks: [task] });
    const verifyRun = {
      id: 'V1',
      command: 'node legacy/report.mjs',
      exitCode: 1,
      output: 'legacy total expected 3',
      preExisting: ['legacy/report.mjs:2:1'],
      workspaceSnapshotId: 'snap-2',
      ts: '2026-01-01T00:01:00.000Z',
    };
    const ledger: EvidenceLedger = {
      ...base,
      tasks: base.tasks.map((entry) => ({
        ...entry,
        checks: [{ id: 'K1', command: 'npm test', exitCode: 0, ts: '2026-01-01T00:00:00.000Z' }],
      })),
      verifyChecks: [verifyRun],
    };

    const checks = buildChecks({ ledger, events: [] });

    expect(checks.entries).toEqual([
      {
        taskId: 'T001',
        id: 'K1',
        command: 'npm test',
        exitCode: 0,
        ts: '2026-01-01T00:00:00.000Z',
      },
      verifyRun,
    ]);
    expect(renderWholeChecksLog(checks).split('\n')).toContain(
      '- V1 (exit 1): node legacy/report.mjs',
    );
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
