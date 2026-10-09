import { afterEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { makeTask } from '#testing/helpers/factories/task.js';
import { makeImplState } from '#testing/helpers/factories/workflow-state.js';
import { transition } from '../../../core/state/machine.js';
import { TaskSpecSchema } from '../../../core/schemas/plan.js';
import { CheckResultSchema, TaskIdSchema } from '../../../core/schemas/task.js';
import { TaskStatusSchema } from '../../../core/schemas/enums.js';
import { taskFromSpec } from '../../spec/plan-tasks.js';
import { hashTaskBrief } from '../../../core/evidence/brief-hash.js';
import {
  cleanupTaskProjects,
  makeTaskWorkflowContext,
} from '#testing/helpers/orchestrator-task-context.js';
import { readEvidenceLedger } from '../../../core/evidence/ledger-storage.js';
import { persistTaskEvidence } from './persistence.js';

afterEach(() => {
  cleanupTaskProjects();
});

describe('persistTaskEvidence — brief hash', () => {
  it('stamps each entry with its own brief, so later run output and plan revisions leave it current', async () => {
    const first = makeTask({ id: 'T001', title: 'First', suggestedFiles: ['src/a.ts'] });
    const second = makeTask({ id: 'T002', title: 'Second', suggestedFiles: ['src/b.ts'] });
    const wctx = makeTaskWorkflowContext();
    let state = makeImplState([first, second]);
    await persistTaskEvidence({
      wctx,
      state,
      task: first,
      recordKind: 'local',
      details: { status: 'done', method: 'local', changedFiles: ['src/a.ts'] },
    });

    state = transition(state, {
      type: 'RECORD_CHECK_RESULTS',
      taskId: first.id,
      results: [{ id: 'K1', passed: true }],
    });
    state = transition(state, {
      type: 'REPLACE_TASK',
      taskId: second.id,
      task: { ...second, description: 'Rewritten by the consult' },
    });
    state = transition(state, {
      type: 'INSERT_TASKS',
      parentId: null,
      tasks: [makeTask({ id: 'T003', title: 'Third', suggestedFiles: ['src/c.ts'] })],
    });

    const entry = readEvidenceLedger(wctx)?.tasks.find((task) => task.id === first.id);
    const [finalFirst] = state.tasks;
    if (finalFirst === undefined) throw new Error('expected the first brief');
    expect(entry?.briefHash).toBe(hashTaskBrief([finalFirst]));
  });
});

const RecordedRunSchema = z.object({
  session: z.string(),
  tasks: z.array(TaskSpecSchema),
  ledger: z.array(
    z.object({
      id: TaskIdSchema,
      status: TaskStatusSchema,
      briefHash: z.string(),
      checkResults: z.array(CheckResultSchema).optional(),
      refreshedInputHashes: z.record(z.string(), z.string()).optional(),
    }),
  ),
});

const RECORDED_RUNS = join(import.meta.dirname, '../../../../testing/fixtures/brief-hash');

/**
 * Replays a recorded run the way the engine ran it, in ledger order: a stale refresh writes the
 * brief's input hashes, the brief starts, its checks record their results, it passes or fails, and
 * the engine books its evidence against the brief it dispatched.
 */
async function replayRecordedRun(name: 's9' | 's11') {
  const run = RecordedRunSchema.parse(
    JSON.parse(readFileSync(join(RECORDED_RUNS, `${name}.json`), 'utf8')),
  );
  const wctx = makeTaskWorkflowContext();
  let state = makeImplState(run.tasks.map((spec) => taskFromSpec(spec, wctx.projectDir)));
  for (const entry of run.ledger) {
    if (entry.status === 'pending') continue;
    if (entry.refreshedInputHashes !== undefined) {
      state = transition(state, {
        type: 'SET_TASK_INPUT_HASHES',
        taskId: entry.id,
        inputHashes: entry.refreshedInputHashes,
      });
    }
    state = transition(state, { type: 'START_TASK', taskId: entry.id });
    const dispatched = state.tasks.find((task) => task.id === entry.id);
    if (dispatched === undefined) throw new Error(`${entry.id} is not in the plan`);
    state = transition(state, { type: 'TASK_SENT' });
    if (entry.checkResults !== undefined) {
      state = transition(state, {
        type: 'RECORD_CHECK_RESULTS',
        taskId: entry.id,
        results: entry.checkResults,
      });
    }
    if (entry.status === 'done') state = transition(state, { type: 'VALIDATION_PASS' });
    await persistTaskEvidence({
      wctx,
      state,
      task: dispatched,
      recordKind: 'local',
      details: { status: entry.status },
    });
  }
  const ledger = readEvidenceLedger(wctx);
  if (ledger === null) throw new Error(`${name} replay wrote no ledger`);
  return { ledger, tasks: state.tasks };
}

// S9 (12 briefs, check results only) and S11 (check results plus stale refreshes of T006 and
// T007): every brief the old engine recorded fell into `Earlier work ─`. Their own evidence.json
// files keep the whole-plan stamps they were written with.
describe('persistTaskEvidence — recorded runs', () => {
  it.each(['s9', 's11'] as const)(
    '%s: every brief the run recorded carries the hash of its final brief',
    async (name) => {
      const { ledger, tasks } = await replayRecordedRun(name);
      const recorded = ledger.tasks.filter((entry) => entry.status !== 'pending');
      expect(recorded.length).toBeGreaterThan(0);
      expect(recorded.map((entry) => [entry.id, entry.briefHash])).toEqual(
        recorded.map((entry) => {
          const final = tasks.find((task) => task.id === entry.id);
          if (final === undefined) throw new Error(`${entry.id} is not in the final plan`);
          return [entry.id, hashTaskBrief([final])];
        }),
      );
    },
  );

  it('s11: leaves the briefs the run never reached unstamped', async () => {
    const { ledger } = await replayRecordedRun('s11');
    const unreached = ledger.tasks.filter((entry) => entry.status === 'pending');
    expect(unreached.map((entry) => entry.id)).toEqual([
      'T009',
      'T010',
      'T011',
      'T012',
      'T013',
      'T014',
    ]);
    expect(unreached.map((entry) => entry.briefHash)).toEqual(unreached.map(() => null));
  });
});
