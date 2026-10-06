import { describe, expect, it } from 'vitest';
import { makeTask } from '#testing/helpers/factories/task.js';
import { makeWorkflowState } from '#testing/helpers/factories/workflow-state.js';
import { makeRunRecord } from '#testing/helpers/factories/run-record.js';
import { makeSummary } from '#testing/helpers/factories/summary.js';
import { makeCostBreakdown } from '#testing/helpers/factories/cost-breakdown.js';
import { createEvidenceLedger, emptyEvidenceTask } from '../../../core/evidence/ledger-state.js';
import type { EvidenceLedger } from '../../../core/schemas/evidence.js';
import { hashTaskBrief } from '../../../engine/brief-hash.js';
import type { Task } from '../../../core/schemas/task.js';
import type { Summary } from '../../../core/schemas/summary.js';
import { deriveSummaryView } from './view-model.js';
import { outcomeLine } from './outcome.js';

const oldTask = makeTask({
  id: 'T001',
  title: 'Old task',
  suggestedFiles: ['old.ts'],
  status: 'done',
});
const newTask = makeTask({ id: 'T001', title: 'New task', suggestedFiles: ['new.ts'] });
const oldLedger = createEvidenceLedger({
  sessionId: 'proof',
  feature: 'proof',
  tasks: [oldTask],
});
oldLedger.tasks[0] = {
  ...emptyEvidenceTask(oldTask),
  status: 'done',
  briefHash: hashTaskBrief([oldTask]),
  changedFiles: ['old.ts'],
  method: 'local',
  retries: 3,
};

function view(
  tasks: Task[],
  summary: Partial<Summary> = {},
  ledger: EvidenceLedger | null = oldLedger,
) {
  const result = deriveSummaryView({
    record: makeRunRecord({
      status: { kind: 'closed', as: 'ended' },
      hydration: { kind: 'loaded', state: makeWorkflowState({ phase: 'reviewing-plan', tasks }) },
      ledger,
      summary: makeSummary({
        totalTasks: tasks.length,
        completedByLocal: 0,
        changedFiles: ['old.ts'],
        costBreakdown: makeCostBreakdown({ totalActualCost: 0.42 }),
        taskBreakdown: [
          {
            taskId: oldTask.id,
            taskTitle: oldTask.title,
            method: 'local',
            implementerTokens: 111,
            escalationTokens: 22,
            retryCount: 3,
            cost: 0.42,
          },
        ],
        ...summary,
      }),
    }),
  });
  if (result === null) throw new Error('Expected closed view');
  return result;
}

describe('independent closed attribution proof', () => {
  it('keeps current pending briefs ordered and earlier evidence separate without altering totals', () => {
    const result = view([makeTask({ id: 'T003', title: 'Third' }), newTask]);
    expect(result.briefs.rows.map(({ id, state }) => [id, state])).toEqual([
      ['T003', 'pending'],
      ['T001', 'pending'],
    ]);
    expect(result.briefs.earlierRows).toHaveLength(1);
    expect(result.briefs.earlierRows[0]).toMatchObject({ title: 'Old task', retries: 3 });
    expect(result.files.changed).toEqual(['old.ts']);
    expect(result.cost).toEqual({ kind: 'priced', actual: 0.42, partial: false });
  });

  it('does not revive an old persisted stoppedAt for the new pending T001', () => {
    const result = view([newTask], { stoppedAt: { taskId: oldTask.id, partialFiles: ['old.ts'] } });
    expect(result.briefs.rows[0]).toMatchObject({ state: 'pending', partialFiles: 0, retries: 0 });
    expect(result.files.stoppedAt).toBeNull();
    expect([...result.files.partial]).toEqual([]);
    expect(outcomeLine(result, 120)).not.toContain('stopped in');
  });

  it('does not assign stale persisted partial files to an in-progress brief with a new hash', () => {
    const result = view([{ ...newTask, status: 'in_progress' }], {
      stoppedAt: { taskId: oldTask.id, partialFiles: ['old.ts'] },
    });
    expect(result.files.stoppedAt).toEqual({ taskId: newTask.id, partialFiles: [] });
    expect(result.briefs.rows[0]).toMatchObject({ state: 'stopped', partialFiles: 0, retries: 0 });
    expect([...result.files.partial]).toEqual([]);
    expect(result.files.changed).toEqual(['old.ts']);
  });

  it('separates settled evidence from a pending identical brief even with the same plan hash', () => {
    const result = view([{ ...oldTask, status: 'pending' }]);
    expect(result.briefs.rows[0]).toMatchObject({ state: 'pending', retries: 0 });
    expect(result.briefs.earlierRows).toHaveLength(1);
  });

  it('shows retained files after a rewind with no current briefs', () => {
    const result = view([]);
    expect(outcomeLine(result, 120)).toContain('no current briefs');
    expect(outcomeLine(result, 120)).toContain('changes kept');
    expect(result.briefs.earlierRows).toHaveLength(1);
  });

  it('does not claim nothing built when earlier completed work has no recorded changed set', () => {
    const result = view([], { changedFiles: undefined });
    expect(outcomeLine(result, 120)).not.toContain('nothing built');
    expect(outcomeLine(result, 120)).toContain('files not recorded');
  });

  it.each(['hash', 'legacy'] as const)(
    'keeps proven partial files for a matching %s identity',
    (identity) => {
      const active = { ...newTask, status: 'in_progress' as const };
      const ledger = createEvidenceLedger({
        sessionId: 'proof',
        feature: 'proof',
        tasks: [active],
      });
      ledger.tasks[0] = {
        ...emptyEvidenceTask(active),
        changedFiles: ['new.ts'],
        briefHash: identity === 'hash' ? hashTaskBrief([active]) : null,
      };
      const result = view(
        [active],
        {
          changedFiles: ['new.ts'],
          stoppedAt: { taskId: active.id, partialFiles: ['new.ts', 'old.ts'] },
        },
        ledger,
      );
      expect(result.files.stoppedAt).toEqual({ taskId: active.id, partialFiles: ['new.ts'] });
      expect(result.briefs.rows[0]).toMatchObject({ state: 'stopped', partialFiles: 1 });
    },
  );

  it('does not attribute legacy partial files when the saved task file differs', () => {
    const active = { ...newTask, status: 'in_progress' as const };
    const ledger = createEvidenceLedger({ sessionId: 'proof', feature: 'proof', tasks: [active] });
    ledger.tasks[0] = {
      ...emptyEvidenceTask(active),
      file: 'old.ts',
      changedFiles: ['old.ts'],
      briefHash: null,
    };
    const result = view(
      [active],
      { stoppedAt: { taskId: active.id, partialFiles: ['old.ts'] } },
      ledger,
    );
    expect(result.files.stoppedAt?.partialFiles).toEqual([]);
    expect(result.briefs.earlierRows).toHaveLength(2);
  });

  it('retains legacy ledger order when saved state is unavailable', () => {
    const record = makeRunRecord({ ledger: oldLedger, summary: makeSummary({ totalTasks: 1 }) });
    const result = deriveSummaryView({ record });
    expect(result?.briefs.rows.map((row) => row.title)).toEqual(['Old task']);
    expect(result?.briefs.earlierRows).toEqual([]);
  });

  it('keeps an empty prebuild closure honest', () => {
    const ledger = createEvidenceLedger({ sessionId: 'proof', feature: 'proof', tasks: [] });
    const result = view([], { changedFiles: undefined, taskBreakdown: [] }, ledger);
    expect(outcomeLine(result, 120)).toContain('no briefs compiled');
    expect(outcomeLine(result, 120)).toContain('nothing built');
  });

  it('folds repeated executions of a current brief into its one current row', () => {
    const done = makeTask({
      id: 'T009',
      title: 'Twice',
      suggestedFiles: ['twice.ts'],
      status: 'done',
    });
    const result = view(
      [done],
      {
        totalTasks: 1,
        completedByLocal: 1,
        taskBreakdown: [
          {
            taskId: done.id,
            taskTitle: done.title,
            method: 'local',
            implementerTokens: 111,
            escalationTokens: 0,
            retryCount: 1,
          },
          {
            taskId: done.id,
            taskTitle: done.title,
            method: 'local',
            implementerTokens: 40,
            escalationTokens: 7,
            retryCount: 2,
          },
        ],
      },
      null,
    );

    // The spend record is the only trace: both executions are one booking, retried three times
    // in total, and the second execution is not an earlier brief.
    expect(result.briefs.rows).toHaveLength(1);
    expect(result.briefs.rows[0]).toMatchObject({ id: 'T009', retries: 3 });
    expect(result.briefs.earlierRows).toEqual([]);
  });

  it('keeps the latest completion when a legacy ledger row meets two executions', () => {
    const record = makeRunRecord({
      ledger: oldLedger,
      summary: makeSummary({
        totalTasks: 1,
        taskBreakdown: [
          {
            taskId: oldTask.id,
            taskTitle: oldTask.title,
            method: 'local',
            implementerTokens: 10,
            escalationTokens: 0,
            retryCount: 1,
          },
          {
            taskId: oldTask.id,
            taskTitle: oldTask.title,
            method: 'escalated-full',
            implementerTokens: 40,
            escalationTokens: 60,
            retryCount: 2,
          },
        ],
      }),
    });

    const result = deriveSummaryView({ record });
    expect(result?.briefs.rows).toHaveLength(1);
    expect(result?.briefs.rows[0]).toMatchObject({ method: 'escalated-full', retries: 3 });
    expect(result?.briefs.earlierRows).toEqual([]);
  });

  it('keeps a rewound brief with a reused id under another title its own row', () => {
    const done = { ...newTask, status: 'done' as const };
    const result = view(
      [done],
      {
        totalTasks: 1,
        completedByLocal: 1,
        taskBreakdown: [
          {
            taskId: oldTask.id,
            taskTitle: oldTask.title,
            method: 'local',
            implementerTokens: 10,
            escalationTokens: 0,
            retryCount: 0,
          },
          {
            taskId: newTask.id,
            taskTitle: newTask.title,
            method: 'local',
            implementerTokens: 40,
            escalationTokens: 0,
            retryCount: 0,
          },
        ],
      },
      null,
    );

    expect(result.briefs.rows).toHaveLength(1);
    expect(result.briefs.rows[0]).toMatchObject({ id: 'T001', title: 'New task' });
    expect(result.briefs.earlierRows).toHaveLength(1);
    expect(result.briefs.earlierRows[0]).toMatchObject({ id: 'T001', title: 'Old task' });
  });
});
