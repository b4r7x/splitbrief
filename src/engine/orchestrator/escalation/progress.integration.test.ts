import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { useTrustHome } from '#testing/helpers/trust-home.js';
import { cleanupTempDir } from '#testing/helpers/temp-dir.js';
import type { WorkflowState } from '../../../core/schemas/workflow.js';
import { transition } from '../../../core/state/machine.js';
import type { ConsultAnswer } from '../../../core/schemas/consult.js';
import { plainUserMessage } from '../../../core/types/user-input.js';
import { makeTask } from '#testing/helpers/factories/task.js';
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
import type { TypedSeatCall } from '../../runners/typed-output.js';
import { formatRecoveryHeadline } from '../../../core/recovery/headline.js';
import { applyRecoveryAction } from '../recovery/actions.js';
import { resetWorkflow } from '../../../stores/workflow/actions/reset.js';
import { handleRetryAndEscalation } from './handle.js';

vi.setConfig({ testTimeout: 60_000 });

let dirs: string[] = [];
let trustHome: ReturnType<typeof useTrustHome>;

beforeEach(() => {
  trustHome = useTrustHome('escalation-progress-trust-home');
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
    prefix: 'escalation-progress',
    sessionId: 'sess-progress',
  });
  dirs.push(projectDir);
  return { projectDir, sessionId };
}

function validatingState(): WorkflowState {
  return transition(makeImplState([makeTask()]), { type: 'TASK_SENT' });
}

function guidance(diagnosis: string): ConsultAnswer {
  return { answer: { diagnosis, action: 'guidance', instructions: 'Try this.', context: null } };
}

function consultPlanner(script: readonly ConsultAnswer[]): { planner: Planner; prompts: string[] } {
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
      return makeRunnerCallResult({ status: 'completed', text: JSON.stringify(next) });
    },
  });
  return { planner: makePlanner({ typedCall }), prompts };
}

/** Each attempt fails with the next error of the script; past its end the attempt succeeds. */
function scriptedImplementer(errors: readonly string[]): ReturnType<typeof makeImplementer> {
  const retry = vi.fn();
  for (const error of errors) retry.mockResolvedValueOnce({ success: false, output: '', error });
  retry.mockResolvedValue({ success: true, output: 'fixed', usage: null });
  return makeImplementer({ retry });
}

async function escalate(
  errors: readonly string[],
  answers: readonly ConsultAnswer[],
  currentState: WorkflowState = validatingState(),
) {
  const { projectDir, sessionId } = setupProject();
  const { callbacks } = makeCallbacks();
  const { bus, events } = makeBusRecorder();
  const { planner, prompts } = consultPlanner(answers);
  const outcome = await handleRetryAndEscalation({
    wctx: makeWctx({
      projectDir,
      sessionId,
      config: makeNoValidationConfig(),
      planner,
      callbacks,
      implementer: scriptedImplementer(errors),
      bus,
    }),
    task: makeTask(),
    initialError: 'type error',
    currentState,
  });
  return { ...outcome, events, prompts, projectDir, sessionId, bus };
}

describe('the planner decides while the attempts make progress', () => {
  it('a retry that fails differently, then one consult, then a pass: no halt', async () => {
    const { result, state, prompts } = await escalate(['module not found'], [guidance('Missing')]);

    expect(result).toMatchObject({ completed: true, method: 'consulted' });
    expect(prompts).toHaveLength(1);
    expect(state.pendingRecovery).toBeUndefined();
  });

  it('three planner answers that each move the failure: no halt', async () => {
    const { result, state, prompts } = await escalate(
      ['error A', 'error B', 'error C'],
      [guidance('First'), guidance('Second'), guidance('Third')],
    );

    expect(result).toMatchObject({ completed: true, method: 'consulted' });
    expect(prompts).toHaveLength(3);
    expect(state.pendingRecovery).toBeUndefined();
  });

  it('the same failure after two planner answers halts on no progress, naming it and the diagnosis', async () => {
    const { result, state, prompts, events } = await escalate(
      ['still broken', 'still broken', 'still broken'],
      [guidance('First diagnosis'), guidance('Second diagnosis')],
    );

    expect(prompts).toHaveLength(2);
    expect(result).toMatchObject({ completed: false, method: 'failed' });
    const issue = state.pendingRecovery;
    expect(issue).toMatchObject({
      reason: 'no-progress',
      taskId: 'T001',
      availableActions: ['continue', 'skip-current-task', 'end-run'],
      recommendedAction: 'continue',
    });
    expect(issue?.details).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/^Failure: .*still broken/),
        'Last diagnosis: Second diagnosis',
      ]),
    );
    expect(formatRecoveryHeadline(issue!)).toBe('T001 is stuck on the same failure');
    expect(events.some((event) => event.type === 'consult_bound_spent')).toBe(false);
  });

  it('counts only answers in a row: a moved failure, then the same one twice, halts after three', async () => {
    const { state, prompts } = await escalate(
      ['error A', 'error B', 'error B', 'error B'],
      [guidance('First'), guidance('Second'), guidance('Third')],
    );

    expect(prompts).toHaveLength(3);
    expect(state.pendingRecovery).toMatchObject({ reason: 'no-progress' });
  });

  it('a failure that keeps moving stops after ten planner answers', async () => {
    const errors = Array.from({ length: 11 }, (_, index) => `error ${index}`);
    const answers = Array.from({ length: 10 }, (_, index) => guidance(`Diagnosis ${index}`));
    const { state, prompts } = await escalate(errors, answers);

    expect(prompts).toHaveLength(10);
    expect(state.pendingRecovery).toMatchObject({ reason: 'no-progress', taskId: 'T001' });
    expect(formatRecoveryHeadline(state.pendingRecovery!)).toBe(
      'T001 did not settle after 10 planner answers',
    );
  });

  it('continue with a note clears the progress, keeps the note, and the planner is asked again', async () => {
    const halted = await escalate(
      ['still broken', 'still broken', 'still broken'],
      [guidance('First diagnosis'), guidance('Second diagnosis')],
    );
    expect(halted.state.pendingRecovery?.reason).toBe('no-progress');

    const applied = await applyRecoveryAction({
      projectDir: halted.projectDir,
      sessionId: halted.sessionId,
      state: halted.state,
      action: 'continue',
      comment: plainUserMessage('look at the config'),
      bus: halted.bus,
    });
    expect(applied.ok).toBe(true);
    expect(applied.status).toBe('retry-current-task');
    if (!applied.ok) return;
    expect(applied.state.pendingRecovery).toBeUndefined();
    expect(applied.state.lineages?.T001?.notes).toEqual(['look at the config']);
    expect(applied.state.lineages?.T001).not.toHaveProperty('progress');
  });
});
