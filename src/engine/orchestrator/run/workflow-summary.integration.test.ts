import { afterEach, describe, expect, it, vi } from 'vitest';
import { endApplyRun, startApplyRun, type ApplyRun } from '#testing/helpers/apply-run.js';
import { makeConfig } from '#testing/helpers/factories/config.js';
import { makePreparedExecution } from '#testing/helpers/factories/prepared-execution.js';
import { makeTask } from '#testing/helpers/factories/task.js';
import { RUN_CREW, makeWorkflowState } from '#testing/helpers/factories/workflow-state.js';
import {
  makeCallbacks,
  makeImplementer,
  TEST_SINKS,
} from '#testing/helpers/orchestrator-factories.js';
import { persistReadyExecutionState } from '#testing/helpers/persisted-execution.js';
import { makePassingPlanner } from '#testing/helpers/planning-phase.js';
import { runTrackedWorkflow, settleTrackedWorkflows } from '#testing/helpers/tracked-workflow.js';
import { taskId } from '../../../core/schemas/task.js';
import type { TaskTokenUsage } from '../../../core/schemas/tokens.js';
import type { Summary } from '../../../core/schemas/summary.js';
import { reactivateExistingSession } from '../../../core/sessions/active-pointer.js';
import { readSession } from '../../../core/sessions/io.js';
import { runApply } from '../apply/run.js';

vi.mock('../apply/run.js', () => ({ runApply: vi.fn() }));

const runs: ApplyRun[] = [];
afterEach(async () => {
  await settleTrackedWorkflows();
  vi.mocked(runApply).mockReset();
  for (const run of runs.splice(0)) endApplyRun(run);
});

const brief = {
  method: 'local',
  implementerTokens: 10,
  escalationTokens: 0,
  retryCount: 0,
} as const;
const BUILT_ON_TWO_SEATS: TaskTokenUsage[] = [
  { ...brief, taskId: taskId('T001'), taskTitle: 'First', tool: 'claude-code', model: 'haiku' },
  { ...brief, taskId: taskId('T002'), taskTitle: 'Fix', tool: 'claude-code', model: 'sonnet' },
];

const seatsOf = (summary: Summary | null | undefined) =>
  summary?.taskBreakdown?.map((task) => `${task.taskId}:${task.tool}/${task.model}`);

/** A run whose two briefs ran on two BUILD seats, re-entered on Re-run Apply. */
async function rerunApply(sessionId: string) {
  const run = await startApplyRun({ 'a.txt': 'one\n' }, { sessionId, strategy: 'staged-copy' });
  runs.push(run);
  const ref = { projectDir: run.dir, sessionId };
  const state = persistReadyExecutionState(
    ref,
    makeWorkflowState({
      ...RUN_CREW,
      tasks: [makeTask({ id: 'T001', status: 'done' }), makeTask({ id: 'T002', status: 'done' })],
      currentTaskIndex: 2,
      phase: 'complete',
      reviewStatus: 'passed',
      workspace: run.workspace,
      taskBreakdowns: BUILT_ON_TWO_SEATS,
    }),
  );
  const returned = await runTrackedWorkflow({
    prepared: makePreparedExecution({
      ...ref,
      feature: state.feature,
      resumeState: state,
      active: reactivateExistingSession(ref),
      config: makeConfig({
        implementer: { kind: 'cli', tool: 'claude-code', model: 'sonnet' },
        validation: { endChecks: false },
        workflow: { approve: 'none' },
      }),
    }),
    sinks: TEST_SINKS,
    callbacks: makeCallbacks().callbacks,
    _planner: makePassingPlanner(),
    _implementer: makeImplementer(),
  });
  return { returned, saved: readSession(ref)?.summary };
}

describe('the Summary a re-entered run writes', () => {
  it('names every BUILD seat when Re-run Apply closes the run', async () => {
    vi.mocked(runApply).mockImplementation(async (input) => ({
      outcome: 'applied',
      state: input.state,
      files: ['a.txt'],
    }));
    const { returned, saved } = await rerunApply('rerun-apply-applied');
    expect(vi.mocked(runApply)).toHaveBeenCalledTimes(1);
    expect(seatsOf(returned)).toEqual(['T001:claude-code/haiku', 'T002:claude-code/sonnet']);
    expect(seatsOf(saved)).toEqual(['T001:claude-code/haiku', 'T002:claude-code/sonnet']);
  });

  it('names every BUILD seat when Re-run Apply stops on an error', async () => {
    vi.mocked(runApply).mockRejectedValue(new Error('the checkout could not be written'));
    const { returned, saved } = await rerunApply('rerun-apply-error');
    expect(vi.mocked(runApply)).toHaveBeenCalledTimes(1);
    expect(seatsOf(returned)).toEqual(['T001:claude-code/haiku', 'T002:claude-code/sonnet']);
    expect(seatsOf(saved)).toEqual(['T001:claude-code/haiku', 'T002:claude-code/sonnet']);
  });
});
