import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { useTrustHome } from '#testing/helpers/trust-home.js';
import { cleanupTempDir } from '#testing/helpers/temp-dir.js';
import type { WorkflowState } from '../../../core/schemas/workflow.js';
import { transition } from '../../../core/state/machine.js';
import type { ConsultAnswer } from '../../../core/schemas/consult.js';
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

  it('the same failure after each planner answer goes back to the planner: no halt', async () => {
    const { result, state, prompts } = await escalate(
      ['still broken', 'still broken', 'still broken'],
      [guidance('First diagnosis'), guidance('Second diagnosis'), guidance('Third diagnosis')],
    );

    expect(prompts).toHaveLength(3);
    expect(result).toMatchObject({ completed: true, method: 'consulted' });
    expect(state.pendingRecovery).toBeUndefined();
  });

  it('a failure that keeps moving gets a planner answer past ten answers', async () => {
    const errors = Array.from({ length: 11 }, (_, index) => `error ${index}`);
    const answers = Array.from({ length: 11 }, (_, index) => guidance(`Diagnosis ${index}`));
    const { result, state, prompts } = await escalate(errors, answers);

    expect(prompts).toHaveLength(11);
    expect(result).toMatchObject({ completed: true, method: 'consulted' });
    expect(state.pendingRecovery).toBeUndefined();
  });

  it('each planner prompt shows its earlier answers, each before the failure that followed it', async () => {
    const { prompts } = await escalate(
      ['first failure', 'second failure', 'third failure'],
      [guidance('First diagnosis'), guidance('Second diagnosis'), guidance('Third diagnosis')],
    );

    const last = prompts.at(-1) ?? '';
    const order = ['first failure', 'First diagnosis', 'second failure', 'Second diagnosis'].map(
      (text) => last.indexOf(text),
    );
    expect(order.every((index) => index >= 0)).toBe(true);
    expect(order).toEqual([...order].sort((a, b) => a - b));
  });
});
