import { afterEach, describe, expect, it, vi } from 'vitest';
import { makeConfig } from '#testing/helpers/factories/config.js';
import { makeTask } from '#testing/helpers/factories/task.js';
import { makeTaskSpec } from '#testing/helpers/factories/plan.js';
import { makeRunnerCallResult } from '#testing/helpers/factories/runner-call.js';
import { makeImplStateWithMetadata } from '#testing/helpers/factories/workflow-state.js';
import { cliDetectionsFor, rememberDetectedTools } from '#testing/helpers/factories/detection.js';
import {
  makeBusRecorder,
  makeImplementer,
  makePlanner,
} from '#testing/helpers/orchestrator-factories.js';
import {
  cleanupTaskProjects,
  makeTaskWorkflowContext,
  setupTaskProject,
} from '#testing/helpers/orchestrator-task-context.js';
import {
  consultCallAnswering,
  guidanceConsult,
  scriptedTypedCall,
} from '#testing/helpers/typed-planner.js';
import { loadState, saveState } from '../../../core/state/persistence.js';
import { transition } from '../../../core/state/machine.js';
import type { WorkflowState } from '../../../core/schemas/workflow.js';
import type { Task } from '../../../core/schemas/task.js';
import type { WorkflowContext } from '../types.js';
import { applyRecoveryAction } from '../recovery/actions.js';
import { retryAndRecord } from './retry.js';
import { runSingleTask } from './step.js';

afterEach(cleanupTaskProjects);

const fix: NonNullable<Task['fix']> = {
  cycle: 1,
  findings: [{ id: 'F1', text: 'Repair the cache key.', acceptance: null }],
};
const config = makeConfig({
  planner: { kind: 'cli', tool: 'claude-code' },
  reviewer: { kind: 'cli', tool: 'codex' },
  validation: { endChecks: false, testCommand: 'noop' },
});
const blocked = { status: 'blocked' as const, question: 'Which cache key?', filesNeeded: [] };
const failed = { success: false, output: '', error: 'The repair failed.' };

function runTask(wctx: WorkflowContext, state: WorkflowState): Promise<WorkflowState> {
  const task = state.tasks[state.currentTaskIndex];
  if (task === undefined) throw new Error('The recovery lost its task.');
  return runSingleTask({
    wctx,
    task,
    state,
    index: state.currentTaskIndex,
    totalTasks: state.tasks.length,
    taskBreakdowns: [],
    setTrackedState: () => {},
    setCurrentTask: () => {},
  });
}

function retryTask(opts: {
  wctx: WorkflowContext;
  state: WorkflowState;
  task: Task;
  reason?: 'failed' | 'blocked';
}) {
  const { wctx, state, task, reason = 'blocked' } = opts;
  return retryAndRecord({
    wctx,
    state,
    task,
    initialError: failed.error,
    ...(reason === 'blocked' && { initialBlocked: blocked }),
    taskStartSnapshot: { head: 'HEAD', files: [], dirtyFileContents: {} },
    tokensBefore: state.tokenUsage,
    taskBreakdowns: [],
    setTrackedState: () => {},
  });
}

describe('consult seat recovery', () => {
  it.each([
    { reason: 'failed', failure: 'thrown' },
    { reason: 'blocked', failure: 'thrown' },
    { reason: 'blocked', failure: 'quota' },
    { reason: 'failed', failure: 'malformed' },
  ] as const)(
    'retries and switches the reviewer after a $reason consult with $failure output',
    async ({ reason, failure }) => {
      const ref = setupTaskProject();
      await rememberDetectedTools(
        ref.projectDir,
        cliDetectionsFor('ready', ['codex', 'claude-code']),
      );
      const task = makeTask({ id: 'T013', suggestedFiles: ['src/task.ts'], criteria: [], fix });
      const state = makeImplStateWithMetadata([task]);
      const broken = scriptedTypedCall(
        failure === 'malformed'
          ? ['{}', '{}']
          : [
              new Error(
                failure === 'quota'
                  ? 'Insufficient Balance'
                  : 'The reviewer process stopped unexpectedly.',
              ),
            ],
      );
      const planner = makePlanner();
      const { bus, events } = makeBusRecorder();
      const wctx = makeTaskWorkflowContext({
        ...ref,
        config,
        bus,
        planner,
        reviewer: makePlanner({ typedCall: broken.typedCall }),
        implementer: makeImplementer({ retry: vi.fn().mockResolvedValue(failed) }),
      });
      const halted = (await retryTask({ wctx, state, task, reason })).state;

      expect(halted.pendingRecovery).toMatchObject({
        reason:
          failure === 'malformed'
            ? 'seat-protocol-error'
            : failure === 'quota'
              ? 'runner-usage-limit'
              : 'planner-call-failed',
        seat: 'review',
        taskId: task.id,
        switchSeat: { seat: 'review', candidates: [{ tool: 'claude-code' }] },
        availableActions:
          failure === 'malformed'
            ? ['retry-same-worker', 'switch-seat', 'end-run']
            : ['retry-same-worker', 'switch-seat', 'skip-current-task', 'end-run'],
      });
      expect(loadState(ref)?.pendingRecovery).toEqual(halted.pendingRecovery);
      expect(events).toContainEqual(
        expect.objectContaining({
          type: 'recovery_prompted',
          issueId: halted.pendingRecovery?.id,
          taskId: task.id,
        }),
      );

      const retried = await applyRecoveryAction({
        ...ref,
        bus,
        config,
        state: halted,
        action: 'retry-same-worker',
      });
      expect(retried.ok).toBe(true);
      if (!retried.ok) throw new Error(retried.message);
      expect(retried.status).toBe('retry-current-task');
      expect(retried.state.tasks[0]?.status).toBe('pending');
      const answered = consultCallAnswering(() => ({
        answer: {
          action: 'rewrite-task',
          diagnosis: 'The repair brief needs the cache key.',
          task: makeTaskSpec({ id: task.id, suggestedFiles: task.suggestedFiles, criteria: [] }),
        },
      }));
      const recovered = await runTask(
        {
          ...wctx,
          reviewer: makePlanner({ typedCall: answered }),
          implementer: makeImplementer({
            implement: vi
              .fn()
              .mockResolvedValueOnce({ ...failed, blocked })
              .mockResolvedValue({ success: true, output: 'verified' }),
          }),
        },
        retried.state,
      );
      expect(answered.mock.calls.map(([ctx]) => ctx.seat)).toEqual(['reviewer']);
      expect(recovered.lineages?.T013?.consultRecords).toContainEqual(
        expect.objectContaining({ seat: 'review', action: 'rewrite-task' }),
      );
      expect(recovered.pendingRecovery).toBeUndefined();
      expect(recovered.tasks[0]).toMatchObject({ id: task.id, revision: 2, fix });
      expect(planner.typedCall).not.toHaveBeenCalled();

      saveState(ref, halted);
      const switched = await applyRecoveryAction({
        ...ref,
        bus,
        config,
        state: halted,
        action: 'switch-seat',
        candidate: { tool: 'claude-code' },
      });
      expect(switched.ok).toBe(true);
      if (!switched.ok) throw new Error(switched.message);
      expect(switched.switchedSeat).toEqual({ seat: 'review', candidate: { tool: 'claude-code' } });
      expect(switched.switchedConfig?.reviewer).toMatchObject({ kind: 'cli', tool: 'claude-code' });
      expect(switched.switchedConfig?.planner).toEqual(config.planner);
      expect(switched.state.pendingRecovery).toBeUndefined();
      expect(switched.state.tasks[0]?.status).toBe('pending');
    },
  );

  it.each(['plan', 'review'] as const)(
    "halts a %s consult on the progress the other seat's answers left on the lineage",
    async (seat) => {
      const ref = setupTaskProject();
      const task = makeTask({ id: 'T013', criteria: [], ...(seat === 'review' && { fix }) });
      const failure = [{ source: 'blocked', keys: [blocked.question] }];
      let state = makeImplStateWithMetadata([task]);
      for (const unmoved of [0, 1]) {
        state = transition(state, {
          type: 'RECORD_CONSULT',
          taskId: task.id,
          revision: 1,
          reason: 'blocked',
          seat: seat === 'review' ? 'plan' : 'review',
          answer: guidanceConsult(),
          progress: { failure, unmoved, answers: unmoved + 1 },
        });
      }
      const plannerCall = consultCallAnswering(() => guidanceConsult());
      const reviewerCall = consultCallAnswering(() => guidanceConsult());
      const wctx = makeTaskWorkflowContext({
        ...ref,
        config,
        planner: makePlanner({ typedCall: plannerCall }),
        reviewer: makePlanner({ typedCall: reviewerCall }),
      });
      const halted = (await retryTask({ wctx, state, task })).state;
      expect(halted.pendingRecovery).toMatchObject({
        reason: 'no-progress',
        taskId: task.id,
      });
      expect(halted.lineages?.T013?.consultRecords).toHaveLength(2);
      expect(plannerCall).not.toHaveBeenCalled();
      expect(reviewerCall).not.toHaveBeenCalled();
    },
  );
});

describe('a plan consult the planner tool refuses as too long', () => {
  it('halts with no retry and starts the next consult on a fresh session', async () => {
    const ref = setupTaskProject();
    const first = makeTask({ id: 'T001', suggestedFiles: ['src/task.ts'], criteria: [] });
    const second = makeTask({ id: 'T002', suggestedFiles: ['src/other.ts'], criteria: [] });
    const state: WorkflowState = {
      ...makeImplStateWithMetadata([first, second]),
      plannerSessionId: 'S',
    };
    saveState(ref, state);
    const prompts: string[] = [];
    let refuse = true;
    const planner = makePlanner();
    planner.capabilities.supportsSessionResume = true;
    planner.typedCall = (ctx) => ({
      seat: ctx.seat,
      typedOutput: 'strict-native',
      canResume: true,
      invoke: async ({ prompt }) => {
        prompts.push(prompt);
        return refuse
          ? makeRunnerCallResult({
              status: 'failed',
              text: '',
              error: { code: 'input-too-large', message: 'Prompt is too long' },
            })
          : makeRunnerCallResult({ status: 'completed', text: JSON.stringify(guidanceConsult()) });
      },
    });
    const { bus } = makeBusRecorder();
    const wctx = makeTaskWorkflowContext({
      ...ref,
      config,
      bus,
      planner,
      implementer: makeImplementer({ retry: vi.fn().mockResolvedValue(failed) }),
    });

    const halted = (await retryTask({ wctx, state, task: first, reason: 'failed' })).state;

    expect(halted.pendingRecovery).toMatchObject({
      reason: 'planner-call-failed',
      seat: 'plan',
      taskId: 'T001',
      recommendedAction: 'skip-current-task',
    });
    expect(halted.pendingRecovery?.availableActions).not.toContain('retry-same-worker');
    expect(halted.pendingRecovery?.details.join('\n')).toContain('A retry sends the same prompt');

    const skipped = await applyRecoveryAction({
      ...ref,
      bus,
      config,
      state: halted,
      action: 'skip-current-task',
    });
    expect(skipped.ok).toBe(true);
    if (!skipped.ok) throw new Error(skipped.message);
    refuse = false;
    prompts.length = 0;
    await retryTask({
      wctx,
      state: { ...skipped.state, currentTaskIndex: 1 },
      task: second,
      reason: 'failed',
    });

    expect(prompts.length).toBeGreaterThan(0);
    for (const prompt of prompts) {
      expect(prompt).toMatch(/^# Consult on a failing task$/m);
      expect(prompt).toContain('T002');
    }
  });
});
