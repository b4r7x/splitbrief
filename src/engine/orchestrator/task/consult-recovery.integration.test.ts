import { afterEach, describe, expect, it, vi } from 'vitest';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
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
import { BOUNDS } from '../../../core/pipeline-spec/bounds.js';
import type { ConsultSeat } from '../../../core/schemas/consult.js';
import type { WorkflowState } from '../../../core/schemas/workflow.js';
import type { Task } from '../../../core/schemas/task.js';
import type { WorkflowContext } from '../types.js';
import { applyRecoveryAction } from '../recovery/actions.js';
import { requestConsult } from '../consult/request.js';
import { inputHashesNow } from './stale-inputs.js';
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
    'refuses a %s consult after the other seat spends the run allowance',
    async (seat) => {
      const ref = setupTaskProject();
      const planTask = makeTask({ id: 'T012', criteria: [] });
      const fixTask = makeTask({ id: 'T013', criteria: [], fix });
      const task = seat === 'review' ? fixTask : planTask;
      let state: WorkflowState = {
        ...makeImplStateWithMetadata([planTask, fixTask]),
        plannerCalls: { used: BOUNDS.plannerCallsPerRun - 1, allowance: BOUNDS.plannerCallsPerRun },
      };
      const plannerCall = consultCallAnswering(() => guidanceConsult());
      const reviewerCall = consultCallAnswering(() => guidanceConsult());
      const wctx = makeTaskWorkflowContext({
        ...ref,
        config,
        planner: makePlanner({ typedCall: plannerCall }),
        reviewer: makePlanner({ typedCall: reviewerCall }),
      });
      saveState(ref, state);
      const otherTask = seat === 'review' ? planTask : fixTask;
      await requestConsult(
        {
          ...wctx,
          state,
          onStateChange: (next) => {
            state = next;
          },
        },
        {
          task: otherTask,
          reason: 'failed',
          failingOutput: failed.error,
        },
      );
      state = { ...state, currentTaskIndex: seat === 'review' ? 1 : 0 };
      const halted = (await retryTask({ wctx, state, task })).state;
      expect(halted.pendingRecovery).toMatchObject({
        reason: 'planner-calls-spent',
        taskId: task.id,
      });
      expect(halted.plannerCalls?.used).toBe(BOUNDS.plannerCallsPerRun);
      expect(seat === 'review' ? reviewerCall : plannerCall).not.toHaveBeenCalled();
    },
  );

  it.each(['plan', 'review'] as const)(
    'refuses a %s consult after the shared lineage allowance is spent',
    async (seat) => {
      const ref = setupTaskProject();
      const task = makeTask({ id: 'T013', criteria: [], ...(seat === 'review' && { fix }) });
      let state = makeImplStateWithMetadata([task]);
      for (let i = 0; i < BOUNDS.consultsPerLineage; i++) {
        state = transition(state, {
          type: 'RECORD_CONSULT',
          taskId: task.id,
          revision: 1,
          reason: 'failed',
          seat: seat === 'review' ? 'plan' : 'review',
          answer: guidanceConsult(),
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
        reason: 'consult-bound-spent',
        taskId: task.id,
      });
      expect(halted.lineages?.T013?.consults).toBe(BOUNDS.consultsPerLineage);
      expect(plannerCall).not.toHaveBeenCalled();
      expect(reviewerCall).not.toHaveBeenCalled();
    },
  );
});

describe('stale consult recovery', () => {
  it.each([
    { seat: 'plan', failure: 'thrown' },
    { seat: 'review', failure: 'thrown' },
    { seat: 'plan', failure: 'malformed' },
    { seat: 'review', failure: 'malformed' },
    { seat: 'review', failure: 'invalid-action' },
  ] satisfies { seat: ConsultSeat; failure: string }[])(
    'halts a $failure stale answer on $seat and retries its consult',
    async ({ seat, failure }) => {
      const ref = setupTaskProject({ 'src/shared.ts': 'export const key = 1;\n' });
      await rememberDetectedTools(
        ref.projectDir,
        cliDetectionsFor('ready', ['codex', 'claude-code']),
      );
      const task = makeTask({
        id: 'T013',
        suggestedFiles: ['src/task.ts'],
        contextFiles: ['src/shared.ts'],
        criteria: [],
        inputHashes: inputHashesNow(ref.projectDir, ['src/task.ts', 'src/shared.ts']),
        ...(seat === 'review' && { fix }),
      });
      const invalid =
        failure === 'invalid-action'
          ? JSON.stringify({
              answer: {
                diagnosis: 'No repair needed.',
                action: 'verify',
                checkIds: ['V1'],
                reason: 'Already fixed.',
              },
            })
          : '{}';
      const broken = scriptedTypedCall(
        failure === 'thrown'
          ? [new Error('The consult process stopped unexpectedly.')]
          : [invalid, invalid],
      );
      const answered = consultCallAnswering(() => guidanceConsult('Read the new cache key.'));
      const implementer = makeImplementer();
      const { bus, events } = makeBusRecorder();
      const wctx = makeTaskWorkflowContext({
        ...ref,
        config,
        bus,
        implementer,
        planner: makePlanner({ typedCall: seat === 'plan' ? broken.typedCall : answered }),
        reviewer: makePlanner({ typedCall: seat === 'review' ? broken.typedCall : answered }),
      });
      writeFileSync(join(ref.projectDir, 'src/shared.ts'), 'export const key = 2;\n');
      const halted = await runTask(wctx, makeImplStateWithMetadata([task]));
      expect(halted.pendingRecovery).toMatchObject({
        reason: failure === 'thrown' ? 'planner-call-failed' : 'seat-protocol-error',
        seat,
        taskId: task.id,
        switchSeat: { seat },
      });
      expect(loadState(ref)?.pendingRecovery).toEqual(halted.pendingRecovery);
      expect(implementer.implement).not.toHaveBeenCalled();
      expect(implementer.retry).not.toHaveBeenCalled();
      expect(events.filter((event) => event.type === 'warning')).toEqual([]);
      expect(halted.tasks[0]?.inputHashes).toEqual(task.inputHashes);
      expect(halted.lineages?.T013?.staleConsultedRevision.T013).toBeUndefined();

      const retried = await applyRecoveryAction({
        ...ref,
        bus,
        config,
        state: halted,
        action: 'retry-same-worker',
      });
      expect(retried.ok).toBe(true);
      if (!retried.ok) throw new Error(retried.message);
      const recovered = await runTask(
        {
          ...wctx,
          planner: makePlanner({ typedCall: answered }),
          reviewer: makePlanner({ typedCall: answered }),
        },
        retried.state,
      );
      expect(answered.mock.calls.map(([ctx]) => ctx.seat)).toEqual([
        seat === 'review' ? 'reviewer' : 'planner',
      ]);
      expect(recovered.lineages?.T013?.consultRecords).toContainEqual(
        expect.objectContaining({ seat, reason: 'stale', action: 'guidance' }),
      );
      expect(recovered.tasks[0]?.inputHashes?.['src/shared.ts']).toBe(
        inputHashesNow(ref.projectDir, ['src/shared.ts'])['src/shared.ts'],
      );
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
