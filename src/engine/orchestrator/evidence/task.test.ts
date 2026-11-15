import { describe, expect, it } from 'vitest';
import { createEvidenceLedger } from '../../../core/evidence/ledger-state.js';
import { EvidenceLedgerSchema } from '../../../core/schemas/evidence.js';
import {
  recordLocalTaskEvidence,
  recordRetryOrEscalationEvidence,
  recordSkippedTaskEvidence,
  recordRejectEvidence,
} from './task.js';
import { checkEntries } from './record-checks.js';
import { makeTask } from '#testing/helpers/factories/task.js';
describe('recordLocalTaskEvidence', () => {
  it('records completion without adding stage entries or checks', () => {
    const task = makeTask();
    const ledger = createEvidenceLedger({ sessionId: 'sess-1', feature: 'feat', tasks: [task] });
    const updated = recordLocalTaskEvidence({
      ledger,
      task,
      status: 'done',
    });
    expect(updated.tasks[0]?.status).toBe('done');
    expect(updated.tasks[0]?.checks).toEqual([]);
  });

  it('records a check run with its status, command, exit code, artifacts and snapshot', () => {
    const entries = checkEntries({
      workspaceSnapshotId: 'snap-1',
      runs: [
        {
          checkId: 'K1',
          status: 'pass',
          output: 'ok',
          command: 'npm test',
          exitCode: 0,
          artifacts: [{ path: '/tmp/shot.png', sha256: 'abc' }],
        },
      ],
    });

    expect(entries).toEqual([
      {
        id: 'K1',
        status: 'pass',
        command: 'npm test',
        exitCode: 0,
        output: 'ok',
        artifacts: [{ path: '/tmp/shot.png', sha256: 'abc' }],
        workspaceSnapshotId: 'snap-1',
        ts: expect.any(String),
      },
    ]);
  });

  it('records the failures a reviewer check also showed at the run base as pre-existing', () => {
    const entries = checkEntries({
      runs: [
        {
          checkId: 'V1',
          status: 'fail',
          command: 'npm test',
          exitCode: 1,
          output: 'FAIL src/legacy.test.ts > adds\n  ❯ src/legacy.test.ts:5:20',
          failure: { keys: ['src/legacy.test.ts::adds'] },
          preExisting: ['src/legacy.test.ts > adds'],
        },
        {
          checkId: 'V2',
          status: 'fail',
          command: 'cargo test',
          exitCode: 101,
          output: 'boom',
          failure: {
            keys: ['exited with code 101'],
            placeholder: 'exited with code 101 without diagnostics',
          },
        },
        {
          checkId: 'V3',
          status: 'fail',
          command: 'pytest',
          exitCode: 1,
          output: 'x',
          failure: {
            keys: ['exited with code 1'],
            placeholder: 'exited with code 1 without diagnostics',
          },
          preExisting: [],
        },
      ],
    });

    expect(entries[0]).toMatchObject({ id: 'V1', preExisting: ['src/legacy.test.ts > adds'] });
    expect(entries[1]).not.toHaveProperty('preExisting');
    expect(entries[2]).not.toHaveProperty('preExisting');
  });

  it('appends a fix task the ledger does not yet know instead of dropping it', () => {
    const t1 = makeTask({ id: 'T001', status: 'done' });
    const t2 = makeTask({ id: 'T002', status: 'done' });
    const fix = makeTask({ id: 'T003', status: 'pending' });
    const ledger = createEvidenceLedger({ sessionId: 'sess-1', feature: 'feat', tasks: [t1, t2] });

    const updated = recordLocalTaskEvidence({ ledger, task: fix, status: 'done' });

    expect(updated.tasks.map((entry) => entry.id)).toEqual(['T001', 'T002', 'T003']);
    expect(updated.validationSummary).toEqual({ passed: 3, failed: 0, skipped: 0, escalated: 0 });
  });

  it('records the changed files without a prose diff label', () => {
    const task = makeTask({ suggestedFiles: ['src/a.ts', 'src/a.test.ts'] });
    const ledger = createEvidenceLedger({ sessionId: 'sess-1', feature: 'feat', tasks: [task] });
    const updated = recordLocalTaskEvidence({ ledger, task, status: 'done' });

    expect(updated.tasks[0]?.changedFiles).toEqual(['src/a.ts', 'src/a.test.ts']);
    expect(updated.tasks[0]?.checks).toEqual([]);
  });

  it('records failed status and keeps the changed files of each attempt', () => {
    const task = makeTask();
    const ledger = createEvidenceLedger({ sessionId: 'sess-1', feature: 'feat', tasks: [task] });
    const afterFirst = recordLocalTaskEvidence({
      ledger,
      task,
      status: 'in_progress',
      changedFiles: ['src/first.ts'],
    });
    const afterRetry = recordRetryOrEscalationEvidence({
      ledger: afterFirst,
      task,
      status: 'failed',
      escalated: false,
      changedFiles: ['src/second.ts'],
    });
    const exhausted = recordRetryOrEscalationEvidence({
      ledger: afterRetry,
      task,
      status: 'failed',
      escalated: false,
      changedFiles: ['src/third.ts'],
    });

    expect(exhausted.tasks[0]?.status).toBe('failed');
    expect(exhausted.tasks[0]?.changedFiles).toEqual([
      'src/first.ts',
      'src/second.ts',
      'src/third.ts',
    ]);
  });

  it('loads an older ledger that still carries per-task validation stages and drops them', () => {
    const task = makeTask();
    const ledger = recordLocalTaskEvidence({
      ledger: createEvidenceLedger({ sessionId: 'sess-1', feature: 'feat', tasks: [task] }),
      task,
      status: 'done',
    });
    const older = {
      ...ledger,
      tasks: ledger.tasks.map((entry) => ({
        ...entry,
        validation: [{ stage: 'typecheck', passed: false, errorSummary: 'error' }],
      })),
    };

    expect(EvidenceLedgerSchema.parse(older)).toEqual(ledger);
  });
});

describe('recordRetryOrEscalationEvidence', () => {
  it('records escalation', () => {
    const task = makeTask();
    const ledger = createEvidenceLedger({ sessionId: 'sess-1', feature: 'feat', tasks: [task] });
    const updated = recordRetryOrEscalationEvidence({
      ledger,
      task,
      status: 'escalated',
      escalated: true,
    });
    expect(updated.tasks[0]?.escalated).toBe(true);
    expect(updated.tasks[0]?.status).toBe('escalated');
  });

  it('records an escalated task without changed-file evidence when no files changed', () => {
    const task = makeTask();
    const ledger = createEvidenceLedger({ sessionId: 'sess-1', feature: 'feat', tasks: [task] });
    const updated = recordRetryOrEscalationEvidence({
      ledger,
      task,
      status: 'escalated',
      escalated: true,
    });

    expect(updated.tasks[0]?.changedFiles).toEqual([]);
    expect(updated.tasks[0]?.checks).toEqual([]);
  });
});

describe('recordSkippedTaskEvidence', () => {
  it('marks task as skipped with reason', () => {
    const task = makeTask();
    const ledger = createEvidenceLedger({ sessionId: 'sess-1', feature: 'feat', tasks: [task] });
    const updated = recordSkippedTaskEvidence({ ledger, task, reason: 'dep failed' });
    expect(updated.tasks[0]?.status).toBe('skipped');
    expect(updated.tasks[0]?.checks).toEqual([]);
  });
});

describe('recordRejectEvidence', () => {
  it('drops the files a reject put back and gives each brief that booked one its status', () => {
    const first = makeTask({ id: 'T001', status: 'done' });
    const second = makeTask({ id: 'T002', status: 'done' });
    const ledger = [
      { task: first, changedFiles: ['src/a.ts', 'src/b.ts'] },
      { task: second, changedFiles: ['src/c.ts'] },
    ].reduce(
      (next, { task, changedFiles }) =>
        recordLocalTaskEvidence({ ledger: next, task, status: 'done', changedFiles }),
      createEvidenceLedger({ sessionId: 'sess-1', feature: 'feat', tasks: [first, second] }),
    );

    const updated = recordRejectEvidence({
      ledger,
      removed: ['src/b.ts'],
      tasks: [{ ...first, status: 'pending' }, second],
    });

    expect(updated.tasks.map((entry) => [entry.id, entry.status, entry.changedFiles])).toEqual([
      ['T001', 'pending', ['src/a.ts']],
      ['T002', 'done', ['src/c.ts']],
    ]);
    expect(updated.validationSummary).toMatchObject({ passed: 1 });
  });
});
