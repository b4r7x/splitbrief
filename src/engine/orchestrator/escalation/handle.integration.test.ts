import { plainUserMessage } from '../../../core/types/user-input.js';

import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { useTrustHome } from '#testing/helpers/trust-home.js';
import { join } from 'node:path';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { cleanupTempDir } from '#testing/helpers/temp-dir.js';
import { lineageAttemptsOf, type WorkflowState } from '../../../core/schemas/workflow.js';
import { transition } from '../../../core/state/machine.js';
import { loadState } from '../../../core/state/persistence.js';
import { lineageIdOf } from '../../../core/state/task-insert.js';
import type { ConsultAnswer } from '../../../core/schemas/consult.js';
import type { TaskSpec } from '../../../core/schemas/plan.js';
import { makeTask } from '#testing/helpers/factories/task.js';
import { makeTaskSpec } from '#testing/helpers/factories/plan.js';
import { makeRunnerCallResult } from '#testing/helpers/factories/runner-call.js';
import { makeNoValidationConfig } from '#testing/helpers/factories/config.js';
import { makeImplState } from '#testing/helpers/factories/workflow-state.js';
import {
  makeCallbacks,
  makePlanner,
  makeImplementer,
  makeBusRecorder,
  makeWctx,
  disposeWctxIsolations,
} from '#testing/helpers/orchestrator-factories.js';
import { setupGitSessionProject } from '#testing/helpers/git-session.js';
import type { Planner, TypedCallContext } from '../../planners/types.js';
import type { Implementer } from '../../implementers/types.js';
import { createSteeringPort } from '../../calls/steering.js';
import type { TypedSeatCall } from '../../runners/typed-output.js';
import { handleRetryAndEscalation } from './handle.js';
import type { HooksConfig } from '../../../core/schemas/hooks.js';
import { markHooksConfigTrusted } from '../../../core/hooks/trust.js';
import { formatRecoveryHeadline } from '../../../core/recovery/headline.js';
import { runnerCallOutcome } from '../../implementers/pipeline/call-result.js';
import { cliDetectionsFor, rememberDetectedTools } from '#testing/helpers/factories/detection.js';
import { makeBaseConfig } from '#testing/helpers/factories/implementer-base.js';
import { makeTaskStart } from '#testing/helpers/events/task.js';
import { createImplementerBase } from '../../implementers/pipeline/run.js';
import { createImplementerPublisher } from '../events.js';
import * as commandRunner from '../../../lib/process/spawn/run-command.js';
import { enqueueUserMessage } from '../queue/submit.js';
import { CORRECTION_AFTER_CHECKS } from '../task/brief-gate.js';
import { addEvent } from '../../../stores/workflow/actions/event.js';
import { resetWorkflow } from '../../../stores/workflow/actions/reset.js';

vi.setConfig({ testTimeout: 60_000 });

let dirs: string[] = [];
let trustHome: ReturnType<typeof useTrustHome>;

beforeEach(() => {
  trustHome = useTrustHome('escalation-handle-trust-home');
});

afterEach(async () => {
  vi.restoreAllMocks();
  await disposeWctxIsolations();
  for (const d of dirs) cleanupTempDir(d);
  dirs = [];
  trustHome.restore();
  resetWorkflow();
});

function setupProject(): { projectDir: string; sessionId: string } {
  const { projectDir, sessionId } = setupGitSessionProject({
    prefix: 'escalation-test',
    sessionId: 'sess-esc',
  });
  dirs.push(projectDir);
  return { projectDir, sessionId };
}

function makeValidatingState(): WorkflowState {
  const task = makeTask();
  let state = makeImplState([task]);
  state = transition(state, { type: 'TASK_SENT' });
  return state;
}

function guidanceAnswer(
  diagnosis: string,
  instructions: string,
  context: string | null = null,
): ConsultAnswer {
  return { answer: { diagnosis, action: 'guidance', instructions, context } };
}

function splitAnswer(diagnosis: string, specs: readonly TaskSpec[]): ConsultAnswer {
  return { answer: { diagnosis, action: 'split-task', tasks: [...specs] } };
}

/** A planner seat whose typed consult calls answer from a script, in order. */
function consultPlanner(script: readonly ConsultAnswer[]): {
  planner: Planner;
  prompts: string[];
} {
  const answers = [...script];
  const prompts: string[] = [];
  const typedCall = (ctx: TypedCallContext): TypedSeatCall => ({
    seat: ctx.seat,
    typedOutput: 'fallback',
    canResume: false,
    invoke: async ({ prompt }) => {
      prompts.push(prompt);
      const next = answers.shift();
      if (next === undefined) throw new Error('the planner was asked once too often');
      return makeRunnerCallResult({
        status: 'completed',
        text: JSON.stringify(next),
        usage: { inputTokens: 10, outputTokens: 5 },
      });
    },
  });
  return { planner: makePlanner({ typedCall }), prompts };
}

/** Each attempt fails with `still broken`; past `failures` attempts, when given, it passes. */
function failingImplementer(failures?: number): ReturnType<typeof makeImplementer> {
  const failed = {
    success: false,
    output: '',
    error: 'still broken',
    usage: { inputTokens: 10, outputTokens: 5 },
  };
  const retry = vi.fn();
  if (failures === undefined) return makeImplementer({ retry: retry.mockResolvedValue(failed) });
  for (let index = 0; index < failures; index += 1) retry.mockResolvedValueOnce(failed);
  return makeImplementer({ retry: retry.mockResolvedValue({ success: true, output: 'fixed' }) });
}

// Validation disabled so runValidationWithEvents returns [] → treated as all-pass.
// Commit strategy 'none' so we don't need a dirty repo for every happy-path test.
describe('handleRetryAndEscalation', () => {
  it('delivers a live message to the consult-guided retry through the run steering port', async () => {
    const ref = setupProject();
    const task = makeTask();
    const steering = createSteeringPort();
    const received: string[] = [];
    const { planner } = consultPlanner([
      guidanceAnswer('The export is missing', 'Add the named export.'),
    ]);
    const implementer = makeImplementer({
      retry: async (opts) => {
        const detach = opts.steering?.attach({
          callId: 'consult-retry',
          role: 'implementer',
          taskId: task.id,
          send: async ({ text }) => {
            received.push(text);
            return 'delivered';
          },
        });
        try {
          await steering.current()?.send({ id: 'live-consult-retry', text: 'keep the alias' });
          return { success: true, output: 'fixed' };
        } finally {
          detach?.();
        }
      },
    });

    const outcome = await handleRetryAndEscalation({
      wctx: makeWctx({ ...ref, implementer, planner, steering }),
      task,
      initialError: 'type error',
      currentState: makeValidatingState(),
    });

    expect(outcome.result).toMatchObject({ completed: true, method: 'consulted', attempts: 1 });
    expect(received).toEqual(['keep the alias']);
    expect(steering.current()).toBeNull();
  });

  it('delivers a correction from green verify checks during a consult without another consult', async () => {
    const ref = setupProject();
    const task = makeTask({
      id: 'T001',
      checks: [{ id: 'K1', kind: 'cmd', value: 'node --version' }],
    });
    const currentState = transition(transition(makeImplState([task]), { type: 'TASK_SENT' }), {
      type: 'COUNT_ATTEMPT',
      taskId: task.id,
    });
    const { bus, events } = makeBusRecorder();
    const retry = vi
      .fn<Implementer['retry']>()
      .mockResolvedValueOnce({ success: false, output: '', error: 'still broken' })
      .mockResolvedValueOnce({ success: true, output: 'fixed' });
    const { planner, prompts } = consultPlanner([
      guidanceAnswer('The export is missing', 'Add the named export.'),
      {
        answer: {
          diagnosis: 'The change now meets the brief',
          action: 'verify',
          checkIds: ['K1'],
          reason: 'Verify K1',
        },
      },
    ]);
    let checks = 0;
    const runCommand = vi.spyOn(commandRunner, 'runCommand').mockImplementation(async () => {
      checks += 1;
      if (checks === 1) {
        const state = loadState(ref);
        if (state === null) throw new Error('missing state during verify checks');
        expect(state.lineages?.T001?.consultRecords).toHaveLength(2);
        enqueueUserMessage({
          ...ref,
          state,
          message: plainUserMessage('keep the alias'),
          phase: state.phase,
          bus,
        });
      }
      return { stdout: 'ok', stderr: '', code: 0 };
    });

    const outcome = await handleRetryAndEscalation({
      wctx: makeWctx({
        ...ref,
        config: makeNoValidationConfig({ workflow: { review: 'task' } }),
        planner,
        implementer: makeImplementer({ retry }),
        bus,
      }),
      task,
      initialError: 'check K1 failed',
      currentState,
    });

    expect(prompts).toHaveLength(2);
    expect(retry).toHaveBeenCalledTimes(2);
    expect(retry.mock.calls[1]?.[0]).toMatchObject({ error: CORRECTION_AFTER_CHECKS });
    expect(retry.mock.calls[1]?.[0].continuation?.steer).toContain('keep the alias');
    expect(runCommand).toHaveBeenCalledTimes(2);
    expect(outcome.result).toMatchObject({ completed: true, method: 'consulted', attempts: 2 });
    expect(outcome.state.tasks[0]?.status).toBe('done');
    expect(outcome.state.lineages?.T001).toMatchObject({ attempts: 3 });
    expect(outcome.state.lineages?.T001?.consultRecords).toHaveLength(2);
    expect(outcome.state.pendingRecovery).toBeUndefined();
    expect(events.filter((event) => event.type === 'queue_drained')).toEqual([
      expect.objectContaining({ count: 1, seat: 'build', taskId: task.id }),
    ]);
    expect(loadState(ref)?.messageQueue[0]?.deliveredTo?.implementer).toBeDefined();
  });

  it('consults the planner before the first retry, with no local retry', async () => {
    const { projectDir, sessionId } = setupProject();
    const { bus } = makeBusRecorder();
    const order: string[] = [];
    bus.subscribe((event) => {
      if (event.type === 'consult_answered') order.push('consult');
    });
    const retry = vi.fn<Implementer['retry']>(async (opts) => {
      order.push(`${opts.kind} retry, attempt ${opts.attempt}`);
      return { success: true, output: 'fixed' };
    });
    const { planner, prompts } = consultPlanner([
      guidanceAnswer('The export is missing', 'Add the named export.'),
    ]);

    const { result } = await handleRetryAndEscalation({
      wctx: makeWctx({
        projectDir,
        sessionId,
        config: makeNoValidationConfig(),
        planner,
        implementer: makeImplementer({ retry }),
        bus,
      }),
      task: makeTask(),
      initialError: 'type error',
      currentState: makeValidatingState(),
    });

    expect(order).toEqual(['consult', 'consult retry, attempt 1']);
    expect(prompts[0]).toContain('type error');
    expect(result).toMatchObject({ completed: true, method: 'consulted', attempts: 1 });
  });

  it('halts as repeated timeouts when the first call and the consult-guided attempt both time out', async () => {
    const { projectDir, sessionId } = setupProject();
    const config = makeNoValidationConfig();
    const retry = vi.fn<Implementer['retry']>().mockResolvedValue({
      success: false,
      output: '',
      error: 'implementer timed out',
      outcome: 'timeout',
    });
    const { planner, prompts } = consultPlanner([
      guidanceAnswer('The call ran out of time', 'Write the smaller change first.'),
    ]);

    const { result, state } = await handleRetryAndEscalation({
      wctx: makeWctx({
        projectDir,
        sessionId,
        config,
        planner,
        implementer: makeImplementer({ retry }),
        bus: makeBusRecorder().bus,
      }),
      task: makeTask(),
      initialError: 'implementer timed out',
      currentState: makeValidatingState(),
      initialFailure: { outcome: 'timeout', runner: config.implementer },
    });

    expect(prompts).toHaveLength(1);
    expect(retry).toHaveBeenCalledTimes(1);
    expect(retry.mock.calls[0]?.[0]).toMatchObject({ kind: 'consult' });
    expect(result.completed).toBe(false);
    expect(state.pendingRecovery).toMatchObject({ reason: 'runner-timeout-repeated' });
  });

  it('delivers a held correction before any consult and completes with method=local', async () => {
    const { projectDir, sessionId } = setupProject();
    const { callbacks } = makeCallbacks();
    const { planner, prompts } = consultPlanner([]);
    const task = makeTask();
    const state = transition(makeValidatingState(), { type: 'RESUME_TASK' });
    const implementer = makeImplementer(); // default retry returns success

    const { result } = await handleRetryAndEscalation({
      wctx: makeWctx({
        projectDir,
        sessionId,
        config: makeNoValidationConfig(),
        planner,
        callbacks,
        implementer,
        bus: makeBusRecorder().bus,
      }),
      task,
      initialError: 'Use the existing helper.',
      currentState: state,
      initialAnswer: 'Use the existing helper.',
    });

    expect(result.completed).toBe(true);
    expect(result.method).toBe('local');
    expect(prompts).toEqual([]);
    expect(implementer.retry).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'correction', error: 'Use the existing helper.' }),
    );
  });

  it('consults the planner on every red with the exact errors, in order', async () => {
    const { projectDir, sessionId } = setupProject();
    const { callbacks } = makeCallbacks();
    const { bus, events } = makeBusRecorder();
    const implementer = failingImplementer(1);
    const { planner, prompts } = consultPlanner([
      guidanceAnswer('First diagnosis', 'Use the named export.'),
      guidanceAnswer('Second diagnosis', 'Check the import path.'),
    ]);

    const { result, state } = await handleRetryAndEscalation({
      wctx: makeWctx({
        projectDir,
        sessionId,
        config: makeNoValidationConfig(),
        planner,
        callbacks,
        implementer,
        bus,
      }),
      task: makeTask(),
      initialError: 'type error',
      currentState: makeValidatingState(),
    });

    const errors = (implementer.retry as ReturnType<typeof vi.fn>).mock.calls.map(
      (call) => (call[0] as { error: string }).error,
    );
    expect(errors).toEqual([
      expect.stringContaining('Use the named export.'),
      expect.stringContaining('Check the import path.'),
    ]);
    expect(events.filter((e) => e.type === 'task_escalating')).toHaveLength(1);
    expect(events.filter((e) => e.type === 'consult_answered')).toHaveLength(2);
    expect(events.filter((e) => e.type === 'escalate')).toEqual([]);
    expect(prompts[0]).toContain('# Consult on a failing task');
    expect(prompts[0]).toContain('type error');
    expect(prompts[1]).toContain('## Brief History');
    expect(prompts[1]).toContain('First diagnosis');
    expect(prompts[1]).toContain('still broken');
    expect(result).toMatchObject({ completed: true, method: 'consulted', attempts: 2 });
    expect(state.pendingRecovery).toBeUndefined();
  });

  it.each(['consult', 'answer'] as const)(
    'announces the lineage attempt before the %s call without an extra Retry row',
    async (kind) => {
      resetWorkflow();
      const { projectDir, sessionId } = setupProject();
      const task = makeTask({ id: 'T013' });
      let currentState = transition(makeImplState([task]), { type: 'TASK_SENT' });
      const used = kind === 'consult' ? 1 : 2;
      for (let index = 0; index < used; index += 1) {
        currentState = transition(currentState, { type: 'COUNT_ATTEMPT', taskId: task.id });
      }
      const { bus, events } = makeBusRecorder();
      bus.subscribe(addEvent);
      addEvent(makeTaskStart({ taskId: task.id, total: 1 }));
      let invocations = 0;
      const invoke = vi.fn(() => {
        invocations += 1;
        return Promise.resolve(
          makeRunnerCallResult({
            status: 'completed',
            text:
              kind === 'consult' && invocations === 1
                ? 'No code yet'
                : '```ts\nexport const hello = "world";\n```',
          }),
        );
      });
      const implementer = createImplementerBase(
        makeBaseConfig({ invoke, publisher: createImplementerPublisher(bus) }),
      );
      const { planner } = consultPlanner([
        guidanceAnswer('The export is missing', 'Add it.'),
        guidanceAnswer('There is still no code', 'Write the export.'),
      ]);

      const outcome = await handleRetryAndEscalation({
        wctx: makeWctx({ projectDir, sessionId, planner, implementer, bus }),
        task,
        initialError: 'type error',
        currentState,
        ...(kind !== 'consult' && { initialAnswer: 'Use the existing helper.' }),
      });

      expect(outcome.result.completed).toBe(true);
      expect(
        events
          .filter((event) => event.type === 'implementer_generate_running')
          .map((event) => event.lineageAttempt),
      ).toEqual(kind === 'consult' ? [2, 3] : [3]);
      expect(lineageAttemptsOf(outcome.state, task)).toBe(3);
    },
  );

  it('a guidance answer retries once with the instructions and completes as consulted', async () => {
    const { projectDir, sessionId } = setupProject();
    const { callbacks } = makeCallbacks();
    const { bus, events } = makeBusRecorder();
    const implementer = makeImplementer({
      retry: vi.fn().mockResolvedValueOnce({ success: true, output: 'fixed', usage: null }),
    });
    const { planner } = consultPlanner([
      guidanceAnswer('The export is missing', 'Add the named export.', 'src/greet.ts'),
    ]);

    const { result } = await handleRetryAndEscalation({
      wctx: makeWctx({
        projectDir,
        sessionId,
        config: makeNoValidationConfig(),
        planner,
        callbacks,
        implementer,
        bus,
      }),
      task: makeTask(),
      initialError: 'type error',
      currentState: makeValidatingState(),
    });

    expect(result.completed).toBe(true);
    expect(result.method).toBe('consulted');
    expect(result.attempts).toBe(1);
    expect(events.find((e) => e.type === 'consult_answered')).toMatchObject({
      type: 'consult_answered',
      taskId: 'T001',
      reason: 'failed',
      action: 'guidance',
      diagnosis: 'The export is missing',
    });
    const consultError = (implementer.retry as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as {
      error: string;
    };
    expect(consultError.error).toContain('type error');
    expect(consultError.error).toContain('Add the named export.');
    expect(consultError.error).toContain('src/greet.ts');
  });

  it('the lineage record persists across a split and a state.json reload', async () => {
    const { projectDir, sessionId } = setupProject();
    const { callbacks } = makeCallbacks();
    const { bus } = makeBusRecorder();
    const implementer = failingImplementer();
    const { planner } = consultPlanner([
      splitAnswer('The brief does two things', [
        makeTaskSpec({ id: 'T100', criteria: ['C1'], suggestedFiles: ['src/split-a.ts'] }),
        makeTaskSpec({ id: 'T101', criteria: ['C2'], suggestedFiles: ['src/split-b.ts'] }),
      ]),
    ]);

    const { state } = await handleRetryAndEscalation({
      wctx: makeWctx({
        projectDir,
        sessionId,
        config: makeNoValidationConfig(),
        planner,
        callbacks,
        implementer,
        bus,
      }),
      task: makeTask(),
      initialError: 'still broken',
      // The first call is booked on the lineage before the ladder, as `retryAndRecord` does.
      currentState: transition(makeValidatingState(), {
        type: 'COUNT_ATTEMPT',
        taskId: makeTask().id,
      }),
    });

    const children = state.tasks.filter((task) => task.parentId === 'T001');
    expect(children.map((child) => child.id)).toEqual(['T002', 'T003']);
    for (const child of children) expect(lineageIdOf(child)).toBe('T001');
    expect(state.lineages?.T001).toMatchObject({ attempts: 1 });
    expect(state.lineages?.T001?.consultRecords).toHaveLength(1);

    const reloaded = loadState({ projectDir, sessionId });
    expect(reloaded?.lineages?.T001).toMatchObject({ attempts: 1 });
    expect(reloaded?.lineages?.T001?.consultRecords).toHaveLength(1);

    // A consult on the subtask shows the parent's lineage, not a fresh one.
    if (reloaded === null) throw new Error('expected the reloaded state');
    const child = reloaded.tasks[reloaded.currentTaskIndex];
    if (child === undefined) throw new Error('expected a subtask');
    const resumed = transition(reloaded, { type: 'RESET_TASK', taskId: child.id });
    const second = consultPlanner([guidanceAnswer('Still failing', 'Try again.')]);
    const { state: after } = await handleRetryAndEscalation({
      wctx: makeWctx({
        projectDir,
        sessionId,
        config: makeNoValidationConfig(),
        planner: second.planner,
        callbacks,
        implementer: failingImplementer(0),
        bus,
      }),
      task: child,
      initialError: 'still broken',
      currentState: resumed,
    });

    expect(second.prompts[0]).toContain('The brief does two things');
    expect(after.lineages?.T001?.consultRecords).toHaveLength(2);
    expect(after.pendingRecovery).toBeUndefined();
  });

  it('a refused command line halts the ladder with a recipe-invalid recovery, without a second consult', async () => {
    const { projectDir, sessionId } = setupProject();
    const { callbacks } = makeCallbacks();
    const { bus, events: busEvents } = makeBusRecorder();
    const task = makeTask({ id: 'T007' });
    const state: WorkflowState = { ...makeValidatingState(), tasks: [task] };
    const { planner, prompts } = consultPlanner([guidanceAnswer('The flag is wrong', 'Retry.')]);
    const implementer = makeImplementer({
      retry: vi.fn().mockResolvedValue({
        success: false,
        output: '',
        error: "error: unknown option '--nope'",
        outcome: 'implementer-recipe-invalid',
      }),
    });

    const { result, state: finalState } = await handleRetryAndEscalation({
      wctx: makeWctx({
        projectDir,
        sessionId,
        config: makeNoValidationConfig(),
        planner,
        callbacks,
        implementer,
        bus,
      }),
      task,
      initialError: 'type error',
      currentState: state,
    });

    expect(result.completed).toBe(false);
    expect(prompts).toHaveLength(1);
    expect(finalState.pendingRecovery).toMatchObject({
      reason: 'implementer-recipe-invalid',
      taskId: 'T007',
    });
    expect(busEvents.find((e) => e.type === 'recovery_prompted')).toMatchObject({
      reason: 'implementer-recipe-invalid',
    });
  });

  it('a changed tool that fails its check again halts the ladder with a check-failed recovery, without a second consult', async () => {
    const { projectDir, sessionId } = setupProject();
    const { callbacks } = makeCallbacks();
    const { bus, events: busEvents } = makeBusRecorder();
    const task = makeTask({ id: 'T007' });
    const state: WorkflowState = { ...makeValidatingState(), tasks: [task] };
    const { planner, prompts } = consultPlanner([guidanceAnswer('The tool changed', 'Retry.')]);
    const implementer = makeImplementer({
      retry: vi.fn().mockResolvedValue({
        success: false,
        output: '',
        error: 'OpenAI Codex CLI version is not compatible.',
        outcome: 'runner-check-failed',
      }),
    });

    const { result, state: finalState } = await handleRetryAndEscalation({
      wctx: makeWctx({
        projectDir,
        sessionId,
        config: makeNoValidationConfig(),
        planner,
        callbacks,
        implementer,
        bus,
      }),
      task,
      initialError: 'type error',
      currentState: state,
    });

    expect(result.completed).toBe(false);
    expect(prompts).toHaveLength(1);
    expect(finalState.pendingRecovery).toMatchObject({
      reason: 'runner-check-failed',
      taskId: 'T007',
      availableActions: expect.arrayContaining([
        'retry-same-worker',
        'skip-current-task',
        'end-run',
      ]),
      recommendedAction: 'retry-same-worker',
    });
    expect(busEvents.find((e) => e.type === 'recovery_prompted')).toMatchObject({
      reason: 'runner-check-failed',
    });
  });

  it('a retry refused for a spent provider balance halts on the seat without a second consult', async () => {
    // Recorded on 2026-10-05: opencode with `deepseek/deepseek-flash` on a spent DeepSeek account.
    const balance =
      'provider.quota: Insufficient Balance (request_id: 021cfcdf-894e-4f9c-8e1b-85ac99f6a0fe)';
    const outcome = runnerCallOutcome(
      makeRunnerCallResult({
        status: 'failed',
        text: '',
        error: { code: 'opencode-error', message: balance },
        backendKind: 'cli',
      }),
    );
    const { projectDir, sessionId } = setupProject();
    const { callbacks } = makeCallbacks();
    const { bus, events } = makeBusRecorder();
    const { planner, prompts } = consultPlanner([guidanceAnswer('The call failed', 'Retry.')]);
    const implementer = makeImplementer({
      retry: vi.fn().mockResolvedValue({
        success: false,
        output: '',
        error: balance,
        ...(outcome.state !== 'success' && { outcome: outcome.state }),
      }),
    });

    const { result, state } = await handleRetryAndEscalation({
      wctx: makeWctx({
        projectDir,
        sessionId,
        config: makeNoValidationConfig(),
        planner,
        callbacks,
        implementer,
        bus,
      }),
      task: makeTask(),
      initialError: 'type error',
      currentState: makeValidatingState(),
    });

    expect(result.completed).toBe(false);
    expect(implementer.retry).toHaveBeenCalledTimes(1);
    expect(prompts).toHaveLength(1);
    expect(events.filter((e) => e.type === 'task_escalating')).toHaveLength(1);
    expect(events.filter((e) => e.type === 'consult_answered')).toHaveLength(1);
    expect(state.pendingRecovery).toMatchObject({ reason: 'runner-usage-limit', taskId: 'T001' });
    expect(state.pendingRecovery?.details.join('\n')).toContain(balance);
    // The brief the seat cut is parked mid-step, so a switch resolves onto the same attempt.
    expect(state.interruptedStep).toMatchObject({
      source: 'seat',
      cut: 'mid-step',
      step: { kind: 'brief', taskId: 'T001' },
    });
  });

  it('a retry refused as signed out halts with the seat switch beside the login, without a second consult', async () => {
    const { projectDir, sessionId } = setupProject();
    await rememberDetectedTools(projectDir, cliDetectionsFor('ready', ['opencode', 'claude-code']));
    const { callbacks } = makeCallbacks();
    const { bus, events } = makeBusRecorder();
    const { planner, prompts } = consultPlanner([guidanceAnswer('The call failed', 'Retry.')]);
    const implementer = makeImplementer({
      retry: vi.fn().mockResolvedValue({
        success: false,
        output: '',
        error: 'HTTP 403 Forbidden',
        outcome: 'unauthenticated',
      }),
    });

    const { result, state } = await handleRetryAndEscalation({
      wctx: makeWctx({
        projectDir,
        sessionId,
        config: makeNoValidationConfig({
          implementer: { kind: 'cli', tool: 'opencode', model: 'deepseek/deepseek-flash' },
        }),
        planner,
        callbacks,
        implementer,
        bus,
      }),
      task: makeTask(),
      initialError: 'type error',
      currentState: makeValidatingState(),
    });

    expect(result.completed).toBe(false);
    expect(implementer.retry).toHaveBeenCalledTimes(1);
    expect(prompts).toHaveLength(1);
    expect(events.filter((e) => e.type === 'consult_answered')).toHaveLength(1);
    expect(state.pendingRecovery).toMatchObject({
      reason: 'runner-unauthenticated',
      recommendedAction: 'switch-seat',
      switchSeat: { seat: 'build', candidates: [{ tool: 'claude-code' }] },
    });
    expect(state.pendingRecovery?.availableActions).toEqual([
      'retry-same-worker',
      'switch-seat',
      'skip-current-task',
      'end-run',
    ]);
  });

  it('pre_escalation deny stops before the consult, attributing retry-exhausted to the hook', async () => {
    const { projectDir, sessionId } = setupProject();
    const task = makeTask({ id: 'T001' });
    // The first call is booked on the lineage before the ladder, as `retryAndRecord` does.
    const state = transition(
      { ...makeValidatingState(), tasks: [task] },
      { type: 'COUNT_ATTEMPT', taskId: task.id },
    );
    writeFileSync(
      join(projectDir, 'deny-escalation.mjs'),
      "console.log(JSON.stringify({ decision: 'deny', message: 'policy: escalation not allowed' }));\n",
    );

    const { callbacks } = makeCallbacks();
    const { bus, events: busEvents } = makeBusRecorder();
    const { planner, prompts } = consultPlanner([]);
    const implementer = failingImplementer();
    const hooks: HooksConfig = {
      pre_escalation: [
        {
          kind: 'command',
          command: 'node',
          args: ['deny-escalation.mjs'],
          timeout_ms: 30_000,
          on_failure: 'warn',
        },
      ],
    };
    markHooksConfigTrusted(projectDir, hooks);

    const { result, state: finalState } = await handleRetryAndEscalation({
      wctx: makeWctx({
        projectDir,
        sessionId,
        config: makeNoValidationConfig({
          hooks,
        }),
        planner,
        callbacks,
        implementer,
        bus,
      }),
      task,
      initialError: 'type error',
      currentState: state,
    });

    expect(result.completed).toBe(false);
    expect(prompts).toEqual([]);
    expect(implementer.retry).not.toHaveBeenCalled();
    expect(busEvents.find((e) => e.type === 'escalate')).toBeUndefined();

    // The recovery is attributed to the hook, not silently mislabeled as retry exhaustion.
    expect(finalState.pendingRecovery).toMatchObject({
      reason: 'retry-exhausted',
      taskId: 'T001',
    });
    expect(finalState.pendingRecovery?.message).toBe(
      'T001 escalation blocked by pre_escalation hook: policy: escalation not allowed',
    );
    expect(finalState.pendingRecovery?.facts?.validationSummary).toBe('type error');
    expect(finalState.pendingRecovery?.facts?.escalationBlockedBy).toBe(
      'policy: escalation not allowed',
    );
    expect(formatRecoveryHeadline(finalState.pendingRecovery!)).toBe(
      finalState.pendingRecovery?.message,
    );
    // Only the first call ran: the hook stops the ladder before any further attempt.
    expect(finalState.pendingRecovery?.details).toContain('Attempts: 1');
  });

  it('halts Needs you with the question when nobody answers the planner, without asking it again', async () => {
    const { projectDir, sessionId } = setupProject();
    const task = makeTask({ id: 'T001' });
    const state = transition(
      { ...makeValidatingState(), tasks: [task] },
      { type: 'COUNT_ATTEMPT', taskId: task.id },
    );
    const { callbacks } = makeCallbacks({ onPlannerReply: vi.fn().mockResolvedValue(undefined) });
    const { bus } = makeBusRecorder();
    const question = 'Which locale table does greet.ts read?';
    const { planner, prompts } = consultPlanner([
      {
        answer: {
          diagnosis: 'The brief names no locale table.',
          action: 'ask-user',
          question,
          whyOnlyUserCanAnswer: 'Only you know which table the product ships.',
          choices: null,
          default: null,
        },
      },
    ]);

    const { result, state: finalState } = await handleRetryAndEscalation({
      wctx: makeWctx({
        projectDir,
        sessionId,
        config: makeNoValidationConfig(),
        planner,
        callbacks,
        implementer: failingImplementer(),
        bus,
      }),
      task,
      initialError: 'type error',
      currentState: state,
    });

    expect(result.completed).toBe(false);
    expect(prompts).toHaveLength(1);
    expect(finalState.pendingRecovery).toMatchObject({
      reason: 'retry-exhausted',
      taskId: 'T001',
      message: 'T001 needs your answer',
      recommendedAction: 'retry-same-worker',
    });
    expect(finalState.pendingRecovery?.details).toContain(`Question: ${question}`);
    expect(formatRecoveryHeadline(finalState.pendingRecovery!)).toBe('T001 needs your answer');
  });

  it('halts Needs you when the planner says the brief cannot be done, with no further implementer call', async () => {
    const { projectDir, sessionId } = setupProject();
    const task = makeTask({ id: 'T001' });
    const state = transition(
      { ...makeValidatingState(), tasks: [task] },
      { type: 'COUNT_ATTEMPT', taskId: task.id },
    );
    const reason = 'The payment API the brief names was removed from the SDK.';
    const { planner, prompts } = consultPlanner([
      {
        answer: {
          diagnosis: 'The SDK has no payment API.',
          action: 'cannot',
          reason,
          next: 'skip-brief',
        },
      },
    ]);
    const plannerCallsAtRetry: number[] = [];
    const implementer = makeImplementer({
      retry: vi.fn().mockImplementation(async () => {
        plannerCallsAtRetry.push(prompts.length);
        return { success: false, output: '', error: 'still broken' };
      }),
    });

    const { result, state: finalState } = await handleRetryAndEscalation({
      wctx: makeWctx({
        projectDir,
        sessionId,
        config: makeNoValidationConfig(),
        planner,
        implementer,
      }),
      task,
      initialError: 'type error',
      currentState: state,
    });

    expect(result.completed).toBe(false);
    expect(prompts).toHaveLength(1);
    expect(plannerCallsAtRetry.every((calls) => calls === 0)).toBe(true);
    expect(finalState.pendingRecovery).toMatchObject({
      reason: 'retry-exhausted',
      taskId: 'T001',
      message: 'T001: the planner says it cannot be done',
      availableActions: ['retry-same-worker', 'decide-for-me', 'skip-current-task', 'end-run'],
    });
    expect(finalState.pendingRecovery?.details).toContain(`Planner said: ${reason}`);
    expect(formatRecoveryHeadline(finalState.pendingRecovery!)).toBe(
      'T001: the planner says it cannot be done',
    );
  });

  it('a pre_validation deny of a consult verify ends the ladder on the skipped task', async () => {
    const { projectDir, sessionId } = setupProject();
    const first = makeTask({ id: 'T001', criteria: ['C1'] });
    const second = makeTask({ id: 'T002' });
    const state = transition(
      makeImplState([first, second], {
        plan: {
          summary: 'Fix the greeting',
          decisions: [],
          criteria: [{ id: 'C1', text: 'The greeting is returned', checkIds: ['K1'] }],
          checks: [{ id: 'K1', kind: 'cmd', value: 'node --version' }],
          validation: null,
        },
      }),
      { type: 'TASK_SENT' },
    );
    writeFileSync(
      join(projectDir, 'deny-validation.mjs'),
      "console.log(JSON.stringify({ decision: 'deny', message: 'policy: validation gated' }));\n",
    );
    const hooks: HooksConfig = {
      pre_validation: [
        {
          kind: 'command',
          command: 'node',
          args: ['deny-validation.mjs'],
          timeout_ms: 30_000,
          on_failure: 'warn',
        },
      ],
    };
    markHooksConfigTrusted(projectDir, hooks);
    const { planner, prompts } = consultPlanner([
      {
        answer: {
          diagnosis: 'K1 predates the task',
          action: 'verify',
          checkIds: ['K1'],
          reason: 'Check K1',
        },
      },
    ]);
    const { bus, events } = makeBusRecorder();

    const { result, state: finalState } = await handleRetryAndEscalation({
      wctx: makeWctx({
        projectDir,
        sessionId,
        config: makeNoValidationConfig({ hooks }),
        planner,
        callbacks: makeCallbacks().callbacks,
        implementer: failingImplementer(),
        bus,
      }),
      task: first,
      initialError: 'type error',
      currentState: state,
    });

    expect(result).toMatchObject({ completed: false, method: 'skipped' });
    expect(prompts).toHaveLength(1);
    expect(finalState.tasks.map((task) => task.status)).toEqual(['skipped', 'pending']);
    expect(finalState.currentTaskIndex).toBe(1);
    expect(finalState.pendingRecovery).toBeUndefined();
    expect(events.filter((e) => e.type === 'task_completed')).toEqual([]);
  });
});

describe('handleRetryAndEscalation /steer on a consult-guided attempt', () => {
  const steerText = 'Keep the helper in src/retry.ts.';
  const stopped = () => new DOMException('The operation was aborted', 'AbortError');
  const fixFinding = { id: 'F1', text: 'The helper swallows the error', acceptance: null };

  it.each([
    ['a brief', 'throw', false],
    ['a brief', 'return', false],
    ['a fix brief', 'throw', true],
    ['a fix brief', 'return', true],
  ] as const)(
    'continues %s with the steer and its kept edits when the cut call exits by %s',
    async (_kind, exit, fix) => {
      const ref = setupProject();
      const task = makeTask({
        id: 'T001',
        suggestedFiles: ['src/retry.ts'],
        ...(fix && { fix: { cycle: 1, findings: [fixFinding] } }),
      });
      const currentState = transition(makeImplState([task]), { type: 'TASK_SENT' });
      const { bus, events } = makeBusRecorder();
      const { planner } = consultPlanner([
        guidanceAnswer('The helper is missing', 'Add the helper to src/retry.ts.'),
      ]);
      let abort: (() => void) | null = null;
      let keptWhenContinued: string | undefined;
      let phaseWhenContinued: string | undefined;
      const retry = vi.fn<Implementer['retry']>(async (call) => {
        if (retry.mock.calls.length === 1) {
          mkdirSync(join(call.projectDir, 'src'), { recursive: true });
          writeFileSync(join(call.projectDir, 'src/retry.ts'), 'export const helper = 1;\n');
          call.onOutput?.('partial consult attempt');
          abort?.();
          if (exit === 'throw') throw stopped();
          return { success: false, output: '', error: 'Aborted', outcome: 'user-abort' };
        }
        keptWhenContinued = readFileSync(join(call.projectDir, 'src/retry.ts'), 'utf8');
        phaseWhenContinued = loadState(ref)?.phase;
        return { success: true, output: 'fixed' };
      });
      const onContinuationNeeded = vi.fn(async () => plainUserMessage(steerText));
      const wctx = makeWctx({
        ...ref,
        bus,
        planner,
        implementer: makeImplementer({ retry }),
        callbacks: makeCallbacks({ onContinuationNeeded }).callbacks,
        sinks: {
          setAbortHandler: (handler) => {
            abort = handler;
          },
          setQueueHandler: () => {},
        },
      });

      const outcome = await handleRetryAndEscalation({
        wctx,
        task,
        initialError: 'type error',
        currentState,
      });

      expect(onContinuationNeeded).toHaveBeenCalledTimes(1);
      expect(events).toContainEqual(
        expect.objectContaining({
          type: 'turn_interrupted',
          at: 'mid-step',
          step: { kind: 'brief', taskId: task.id, attempt: 1 },
        }),
      );
      expect(events).toContainEqual(
        expect.objectContaining({ type: 'user_message', text: steerText, phase: 'escalating' }),
      );
      expect(phaseWhenContinued).toBe('escalating');
      expect(retry).toHaveBeenCalledTimes(2);
      const continued = retry.mock.calls[1]?.[0];
      expect(continued?.continuation?.steer).toContain(steerText);
      expect(continued?.continuation?.partial).toContain('partial consult attempt');
      expect(continued?.continuation?.kept).toEqual(['src/retry.ts']);
      expect(continued?.allowNoChange).toBe(true);
      expect(keptWhenContinued).toBe('export const helper = 1;\n');
      expect(outcome.result).toMatchObject({ completed: true, method: 'consulted' });
      expect(outcome.state.pendingRecovery).toBeUndefined();
      expect(readFileSync(join(ref.projectDir, 'src/retry.ts'), 'utf8')).toBe(
        'export const helper = 1;\n',
      );
    },
  );
});
