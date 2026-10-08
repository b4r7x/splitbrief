import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { useTrustHome } from '#testing/helpers/trust-home.js';
import { join } from 'node:path';
import { writeFileSync } from 'node:fs';
import { cleanupTempDir } from '#testing/helpers/temp-dir.js';
import type { WorkflowState } from '../../../core/schemas/workflow.js';
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
} from '#testing/helpers/orchestrator-factories.js';
import { setupGitSessionProject } from '#testing/helpers/git-session.js';
import { DEFAULT_LOCAL_RETRIES } from '../../../core/pipeline-spec/retries.js';
import type { Planner, TypedCallContext } from '../../planners/types.js';
import type { TypedSeatCall } from '../../runners/typed-output.js';
import { handleRetryAndEscalation } from './handle.js';
import type { HooksConfig } from '../../../core/schemas/hooks.js';
import { markHooksConfigTrusted } from '../../../core/hooks/trust.js';
import { formatRecoveryHeadline } from '../../../core/recovery/headline.js';
import { applyRecoveryAction } from '../recovery/actions.js';
import { runnerCallOutcome } from '../../implementers/pipeline/call-result.js';
import { cliDetectionsFor, rememberDetectedTools } from '#testing/helpers/factories/detection.js';

vi.setConfig({ testTimeout: 60_000 });

let dirs: string[] = [];
let trustHome: ReturnType<typeof useTrustHome>;

beforeEach(() => {
  trustHome = useTrustHome('escalation-handle-trust-home');
});

afterEach(() => {
  for (const d of dirs) cleanupTempDir(d);
  dirs = [];
  trustHome.restore();
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

function failingImplementer(): ReturnType<typeof makeImplementer> {
  return makeImplementer({
    retry: vi.fn().mockResolvedValue({
      success: false,
      output: '',
      error: 'still broken',
      usage: { inputTokens: 10, outputTokens: 5 },
    }),
  });
}

// Validation disabled so runValidationWithEvents returns [] → treated as all-pass.
// Commit strategy 'none' so we don't need a dirty repo for every happy-path test.
describe('handleRetryAndEscalation', () => {
  it('retry succeeds on attempt 1 → completed with method=local', async () => {
    const { projectDir, sessionId } = setupProject();
    const { callbacks } = makeCallbacks();
    const planner = makePlanner();
    const task = makeTask();
    const state = makeValidatingState();
    const implementer = makeImplementer(); // default retry returns success

    const { result } = await handleRetryAndEscalation({
      taskStartTime: Date.now(),
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
      initialError: 'type error',
      currentState: state,
    });

    expect(result.completed).toBe(true);
    expect(result.method).toBe('local');
  });

  it('spends the local retries with the exact errors, then consults the planner in order', async () => {
    const { projectDir, sessionId } = setupProject();
    const { callbacks } = makeCallbacks();
    const { bus, events } = makeBusRecorder();
    const implementer = failingImplementer();
    const { planner, prompts } = consultPlanner([
      guidanceAnswer('First diagnosis', 'Use the named export.'),
      guidanceAnswer('Second diagnosis', 'Check the import path.'),
    ]);

    const { result, state } = await handleRetryAndEscalation({
      taskStartTime: Date.now(),
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
      'type error',
      expect.stringContaining('Use the named export.'),
      expect.stringContaining('Check the import path.'),
    ]);
    expect(events.filter((e) => e.type === 'task_retry')).toHaveLength(DEFAULT_LOCAL_RETRIES);
    expect(events.filter((e) => e.type === 'task_escalating')).toHaveLength(1);
    expect(events.filter((e) => e.type === 'consult_answered')).toHaveLength(2);
    expect(events.filter((e) => e.type === 'escalate')).toEqual([]);
    expect(prompts[0]).toContain('# Consult on a failing task');
    expect(prompts[0]).toContain('still broken');
    expect(prompts[1]).toContain('Earlier Consults on This Lineage');
    expect(result).toMatchObject({ completed: false, method: 'failed', attempts: 3 });
    expect(state.pendingRecovery).toMatchObject({
      reason: 'consult-bound-spent',
      taskId: 'T001',
      availableActions: ['continue', 'skip-current-task', 'end-run'],
    });
    // The halt was raised by the attempt after the second consult; no consult diagnosed that
    // failure, so the panel quotes its own error, not the second consult's diagnosis.
    expect(state.pendingRecovery?.facts?.lastDiagnosis).toBe('still broken');
    expect(state.pendingRecovery?.details?.[0]).toBe('Last diagnosis: still broken');
    expect(formatRecoveryHeadline(state.pendingRecovery!)).toBe('T001 used its consult allowance');
  });

  it('a guidance answer retries once with the instructions and completes as consulted', async () => {
    const { projectDir, sessionId } = setupProject();
    const { callbacks } = makeCallbacks();
    const { bus, events } = makeBusRecorder();
    const implementer = makeImplementer({
      retry: vi
        .fn()
        .mockResolvedValueOnce({ success: false, output: '', error: 'still broken' })
        .mockResolvedValueOnce({ success: true, output: 'fixed', usage: null }),
    });
    const { planner } = consultPlanner([
      guidanceAnswer('The export is missing', 'Add the named export.', 'src/greet.ts'),
    ]);

    const { result } = await handleRetryAndEscalation({
      taskStartTime: Date.now(),
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
    expect(result.attempts).toBe(2);
    expect(events.find((e) => e.type === 'consult_answered')).toMatchObject({
      type: 'consult_answered',
      taskId: 'T001',
      reason: 'failed',
      action: 'guidance',
      diagnosis: 'The export is missing',
    });
    const consultError = (implementer.retry as ReturnType<typeof vi.fn>).mock.calls[1]?.[0] as {
      error: string;
    };
    expect(consultError.error).toContain('still broken');
    expect(consultError.error).toContain('Add the named export.');
    expect(consultError.error).toContain('src/greet.ts');
  });

  it('continue with a note grants one consult and four attempts, and the next consult runs', async () => {
    const { projectDir, sessionId } = setupProject();
    const { callbacks } = makeCallbacks();
    const { bus } = makeBusRecorder();
    const implementer = failingImplementer();
    const first = consultPlanner([
      guidanceAnswer('First diagnosis', 'Try again.'),
      guidanceAnswer('Second diagnosis', 'Try once more.'),
    ]);

    const { state: halted } = await handleRetryAndEscalation({
      taskStartTime: Date.now(),
      wctx: makeWctx({
        projectDir,
        sessionId,
        config: makeNoValidationConfig(),
        planner: first.planner,
        callbacks,
        implementer,
        bus,
      }),
      task: makeTask(),
      initialError: 'type error',
      currentState: makeValidatingState(),
    });
    expect(halted.pendingRecovery?.reason).toBe('consult-bound-spent');

    const applied = await applyRecoveryAction({
      projectDir,
      sessionId,
      state: halted,
      action: 'continue',
      comment: 'grant it',
      bus,
    });
    expect(applied.ok).toBe(true);
    expect(applied.status).toBe('retry-current-task');
    if (!applied.ok) return;
    expect(applied.state.lineages?.T001).toMatchObject({
      consults: 2,
      consultAllowance: 3,
      attemptAllowance: 12,
      notes: ['grant it'],
    });
    expect(applied.state.pendingRecovery).toBeUndefined();
    expect(applied.state.phase).toBe('implementing');

    const second = consultPlanner([guidanceAnswer('Third diagnosis', 'Try again.')]);
    const { result, state: after } = await handleRetryAndEscalation({
      taskStartTime: Date.now(),
      wctx: makeWctx({
        projectDir,
        sessionId,
        config: makeNoValidationConfig(),
        planner: second.planner,
        callbacks,
        implementer,
        bus,
      }),
      task: makeTask(),
      initialError: 'type error',
      currentState: applied.state,
    });

    expect(second.prompts).toHaveLength(1);
    expect(second.prompts[0]).toContain('Earlier Consults on This Lineage');
    expect(second.prompts[0]).toContain('Second diagnosis');
    expect(result).toMatchObject({ completed: false, method: 'failed' });
    expect(after.pendingRecovery).toMatchObject({ reason: 'consult-bound-spent' });
    expect(after.lineages?.T001?.consults).toBe(3);
  });

  it('lineage counters persist across a split and a state.json reload', async () => {
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
      taskStartTime: Date.now(),
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

    const children = state.tasks.filter((task) => task.parentId === 'T001');
    expect(children.map((child) => child.id)).toEqual(['T002', 'T003']);
    for (const child of children) expect(lineageIdOf(child)).toBe('T001');
    expect(state.lineages?.T001).toMatchObject({ consults: 1, attempts: 1 });

    const reloaded = loadState({ projectDir, sessionId });
    expect(reloaded?.lineages?.T001).toMatchObject({
      consults: 1,
      attempts: 1,
      consultAllowance: 2,
      attemptAllowance: 8,
    });

    // A consult on the subtask spends from the parent's lineage, not a fresh one.
    if (reloaded === null) throw new Error('expected the reloaded state');
    const child = reloaded.tasks[reloaded.currentTaskIndex];
    if (child === undefined) throw new Error('expected a subtask');
    const resumed = transition(reloaded, { type: 'RESET_TASK', taskId: child.id });
    const second = consultPlanner([guidanceAnswer('Still failing', 'Try again.')]);
    const { state: after } = await handleRetryAndEscalation({
      taskStartTime: Date.now(),
      wctx: makeWctx({
        projectDir,
        sessionId,
        config: makeNoValidationConfig(),
        planner: second.planner,
        callbacks,
        implementer,
        bus,
      }),
      task: child,
      initialError: 'type error',
      currentState: resumed,
    });

    expect(second.prompts[0]).toContain('Earlier Consults on This Lineage');
    expect(after.lineages?.T001?.consults).toBe(2);
  });

  it('an exhausted ladder fails without advancing the task or taking the brief over', async () => {
    const { projectDir, sessionId } = setupProject();
    // Create a dirty file so the exhausted ladder has real worktree state to leave untouched.
    writeFileSync(join(projectDir, 'task-file.ts'), 'pending content');
    const task = makeTask({ suggestedFiles: ['task-file.ts'], action: 'create' });
    const state = makeValidatingState();
    // Update task list with the file-matching task so shutdown cleanup finds a real path.
    const stateWithTask: WorkflowState = {
      ...state,
      tasks: [task],
    };

    const { callbacks } = makeCallbacks();
    const implementer = failingImplementer();
    const escalateFull = vi.fn();
    const { planner } = consultPlanner([
      guidanceAnswer('Try again', 'Try again.'),
      guidanceAnswer('Try again', 'Try again.'),
    ]);
    const plannerWithTakeover = makePlanner({ ...planner, escalateFull });

    const { result, state: finalState } = await handleRetryAndEscalation({
      taskStartTime: Date.now(),
      wctx: makeWctx({
        projectDir,
        sessionId,
        config: makeNoValidationConfig(),
        planner: plannerWithTakeover,
        callbacks,
        implementer,
        bus: makeBusRecorder().bus,
      }),
      task,
      initialError: 'error',
      currentState: stateWithTask,
    });

    expect(result).toMatchObject({ completed: false, method: 'failed', attempts: 3 });
    expect(escalateFull).not.toHaveBeenCalled();
    expect(finalState.currentTaskIndex).toBe(0);
    expect(finalState.tasks[0]?.status).toBe('pending');
  });

  it('a refused command line halts the ladder with a recipe-invalid recovery, without a consult', async () => {
    const { projectDir, sessionId } = setupProject();
    const { callbacks } = makeCallbacks();
    const { bus, events: busEvents } = makeBusRecorder();
    const task = makeTask({ id: 'T007' });
    const state: WorkflowState = { ...makeValidatingState(), tasks: [task] };
    const { planner, prompts } = consultPlanner([]);
    const implementer = makeImplementer({
      retry: vi.fn().mockResolvedValue({
        success: false,
        output: '',
        error: "error: unknown option '--nope'",
        outcome: 'implementer-recipe-invalid',
      }),
    });

    const { result, state: finalState } = await handleRetryAndEscalation({
      taskStartTime: Date.now(),
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
    expect(prompts).toEqual([]);
    expect(finalState.pendingRecovery).toMatchObject({
      reason: 'implementer-recipe-invalid',
      taskId: 'T007',
    });
    expect(busEvents.find((e) => e.type === 'recovery_prompted')).toMatchObject({
      reason: 'implementer-recipe-invalid',
    });
  });

  it('a retry refused for a spent provider balance halts on the seat without a consult', async () => {
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
    const { planner, prompts } = consultPlanner([]);
    const implementer = makeImplementer({
      retry: vi.fn().mockResolvedValue({
        success: false,
        output: '',
        error: balance,
        ...(outcome.state !== 'success' && { outcome: outcome.state }),
      }),
    });

    const { result, state } = await handleRetryAndEscalation({
      taskStartTime: Date.now(),
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
    expect(prompts).toEqual([]);
    expect(events.filter((e) => e.type === 'task_escalating')).toEqual([]);
    expect(events.filter((e) => e.type === 'consult_answered')).toEqual([]);
    expect(state.pendingRecovery).toMatchObject({ reason: 'runner-usage-limit', taskId: 'T001' });
    expect(state.pendingRecovery?.details.join('\n')).toContain(balance);
    // The brief the seat cut is parked mid-step, so a switch resolves onto the same attempt.
    expect(state.interruptedStep).toMatchObject({
      source: 'seat',
      cut: 'mid-step',
      step: { kind: 'brief', taskId: 'T001' },
    });
  });

  it('a retry refused as signed out halts with the seat switch beside the login, without a consult', async () => {
    const { projectDir, sessionId } = setupProject();
    await rememberDetectedTools(projectDir, cliDetectionsFor('ready', ['opencode', 'claude-code']));
    const { callbacks } = makeCallbacks();
    const { bus, events } = makeBusRecorder();
    const { planner, prompts } = consultPlanner([]);
    const implementer = makeImplementer({
      retry: vi.fn().mockResolvedValue({
        success: false,
        output: '',
        error: 'HTTP 403 Forbidden',
        outcome: 'unauthenticated',
      }),
    });

    const { result, state } = await handleRetryAndEscalation({
      taskStartTime: Date.now(),
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
    expect(prompts).toEqual([]);
    expect(events.filter((e) => e.type === 'consult_answered')).toEqual([]);
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
    const state: WorkflowState = { ...makeValidatingState(), tasks: [task] };
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
      taskStartTime: Date.now(),
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
    expect(busEvents.find((e) => e.type === 'escalate')).toBeUndefined();

    // The recovery is attributed to the hook, not silently mislabeled as retry exhaustion.
    expect(finalState.pendingRecovery).toMatchObject({
      reason: 'retry-exhausted',
      taskId: 'T001',
    });
    expect(finalState.pendingRecovery?.message).toBe(
      'T001 escalation blocked by pre_escalation hook: policy: escalation not allowed',
    );
    expect(finalState.pendingRecovery?.facts?.validationSummary).toBe('still broken');
    expect(finalState.pendingRecovery?.facts?.escalationBlockedBy).toBe(
      'policy: escalation not allowed',
    );
    expect(formatRecoveryHeadline(finalState.pendingRecovery!)).toBe(
      finalState.pendingRecovery?.message,
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
          checks: [{ id: 'K1', kind: 'cmd', value: 'node --version', required: true }],
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
      taskStartTime: Date.now(),
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
