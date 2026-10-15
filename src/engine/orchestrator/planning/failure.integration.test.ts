import { afterEach, describe, expect, it } from 'vitest';
import {
  makeBusRecorder,
  makeCallbacks,
  makePlanner,
  makeWctx,
  TEST_METADATA,
  TEST_SINKS,
} from '#testing/helpers/orchestrator-factories.js';
import { makeConfig } from '#testing/helpers/factories/config.js';
import { makeRunnerCallResult } from '#testing/helpers/factories/runner-call.js';
import { cliDetectionsFor, rememberDetectedTools } from '#testing/helpers/factories/detection.js';
import { cleanupTempDir, createTempDir } from '#testing/helpers/temp-dir.js';
import { defaultCliAuthChannel } from '../../../core/runners/cli-tool-catalog.js';
import { ensureSessionDir } from '../../../core/paths-io.js';
import { createInitialState, transition } from '../../../core/state/machine.js';
import { loadState, saveState } from '../../../core/state/persistence.js';
import { deriveRunStatus } from '../../../core/sessions/run-status.js';
import type { WorkflowState } from '../../../core/schemas/workflow.js';
import { abortError, composeAbortSignal } from '../../../utils/abort.js';
import { WORKFLOW_USER_CANCELLED_ABORT_REASON } from '../../events/workflow-cancel.js';
import { error } from '../../../utils/error.js';
import { runnerCallInterruptedStatus } from '../../calls/status.js';
import { createPlannerBase, type PlannerBaseConfig } from '../../planners/base.js';
import { createShellPlanner } from '../../planners/shell.js';
import type { Planner } from '../../planners/types.js';
import { streamCompletion } from '../../providers/openai-stream/completion.js';
import { interruptedError } from '../../planners/claude-invoke.js';
import type { PlannerCallbacksContext } from '../types.js';
import { addUsageAndSave } from '../state-ops.js';
import { handlePlanningFailure } from './failure.js';
import { writeConfig } from '../../../core/config/load/io.js';
import { runPlanningSession } from './session.js';

let dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs) cleanupTempDir(dir);
  dirs = [];
});

function setupProject(): { projectDir: string; sessionId: string } {
  const projectDir = createTempDir('planning-failure-test');
  dirs.push(projectDir);
  const sessionId = 'sess-planning-failure';
  ensureSessionDir(projectDir, sessionId);
  return { projectDir, sessionId };
}

describe('handlePlanningFailure', () => {
  it.each([true, false])(
    'publishes PLAN advice only without an automatic intent: %s',
    async (auto) => {
      const ref = setupProject();
      await rememberDetectedTools(
        ref.projectDir,
        cliDetectionsFor('ready', ['opencode', 'claude-code']),
      );
      const config = makeConfig({
        planner: {
          kind: 'cli',
          tool: 'opencode',
          model: 'deepseek/deepseek-flash',
          ...(auto && { fallback: { tool: 'claude-code', model: 'sonnet' } }),
        },
      });
      writeConfig(ref.projectDir, config);
      const { bus, events } = makeBusRecorder();
      const result = await handlePlanningFailure({
        ...ref,
        state: { ...createInitialState('feature'), phase: 'planning' },
        err: new Error('provider.quota: Insufficient Balance'),
        wctx: makeWctx({ ...ref, bus, config }),
      });
      expect(result.state.pendingRecovery?.switchSeat?.auto !== undefined).toBe(auto);
      expect(result.state.pendingRecovery?.message).toContain('Add credit');
      const rows = events.filter((event) => event.type === 'error');
      expect(rows).toHaveLength(1);
      if (auto) expect(rows[0]?.message).toBe('Balance spent on OpenCode CLI');
      else expect(rows[0]?.message).toContain('change the PLAN tool');
    },
  );

  it('offers the prepared planner fallback when no config of record exists', async () => {
    const ref = setupProject();
    await rememberDetectedTools(
      ref.projectDir,
      cliDetectionsFor('ready', ['codex', 'claude-code']),
    );
    const fallback = { tool: 'claude-code', model: 'sonnet' };
    const config = makeConfig({ planner: { kind: 'cli', tool: 'codex', fallback } });
    const state = { ...createInitialState('feature'), phase: 'planning' as const };
    const { bus } = makeBusRecorder();
    const result = await handlePlanningFailure({
      ...ref,
      state,
      err: new Error('Please sign in again'),
      wctx: makeWctx({ ...ref, bus, config }),
    });
    expect(result.state.pendingRecovery?.switchSeat).toMatchObject({
      seat: 'plan',
      candidates: [fallback],
    });
    expect(result.state.pendingRecovery?.facts?.fallback).toBeDefined();
  });

  it('aborted planning publishes no `error` event; non-abort failures still do', async () => {
    const { projectDir, sessionId } = setupProject();
    const state = { ...createInitialState('feature'), phase: 'planning' as const };
    const { bus: abortBus, events: abortEvents } = makeBusRecorder();

    await handlePlanningFailure({
      err: error('operation-aborted', 'workflow-rewind'),
      projectDir,
      sessionId,
      state,
      wctx: makeWctx({ projectDir, sessionId, bus: abortBus }),
    });

    expect(abortEvents.some((event) => event.type === 'error')).toBe(false);

    const { bus: failBus, events: failEvents } = makeBusRecorder();
    await handlePlanningFailure({
      err: error('runner-call-failed', 'Planner planner call failed', {
        status: 'failed',
        error: { code: 'planner-failed', message: 'planner exploded' },
      }),
      projectDir,
      sessionId,
      state,
      wctx: makeWctx({ projectDir, sessionId, bus: failBus }),
    });

    const published = failEvents.find((event) => event.type === 'error');
    expect(published?.type === 'error' && published.message).toContain('planner exploded');
  });

  it('an abort parks the step instead of ending the run', async () => {
    const { projectDir, sessionId } = setupProject();
    const state = { ...createInitialState('feature'), phase: 'planning' as const };
    saveState({ projectDir, sessionId }, state);

    const result = await handlePlanningFailure({
      err: error('operation-aborted', 'user stopped it'),
      projectDir,
      sessionId,
      state,
      wctx: makeWctx({ projectDir, sessionId }),
    });

    expect(result).toMatchObject({ disposition: 'terminal', outcome: 'interrupted' });
    expect(result.state.phase).toBe('planning');
    expect(result.state.closed).toBeUndefined();
    expect(result.state.interruptedStep?.source).toBe('user');
    expect(result.state.interruptedStep?.step).toEqual({ kind: 'planner', call: 'plan' });
    expect(loadState({ projectDir, sessionId })?.interruptedStep?.source).toBe('user');
  });

  it('an abort records the stop in the log, naming the step it cut', async () => {
    const { projectDir, sessionId } = setupProject();
    const state = { ...createInitialState('feature'), phase: 'planning' as const };
    saveState({ projectDir, sessionId }, state);
    const { bus, events } = makeBusRecorder();

    await handlePlanningFailure({
      err: error('operation-aborted', 'user stopped it'),
      projectDir,
      sessionId,
      state,
      wctx: makeWctx({ projectDir, sessionId, bus }),
    });

    expect(events.filter((event) => event.type === 'turn_interrupted')).toEqual([
      {
        type: 'turn_interrupted',
        ts: expect.any(Number),
        phase: 'planning',
        source: 'user',
        at: 'mid-step',
        step: { kind: 'planner', call: 'plan' },
      },
    ]);
  });

  it('a stop that lands on a park already recorded keeps that park and adds no row', async () => {
    const { projectDir, sessionId } = setupProject();
    const parked = transition(
      { ...createInitialState('feature'), phase: 'planning' as const },
      {
        type: 'INTERRUPT_STEP',
        step: { kind: 'planner', call: 'plan' },
        source: 'watchdog',
        cut: 'mid-step',
      },
    );
    saveState({ projectDir, sessionId }, parked);
    const { bus, events } = makeBusRecorder();

    const result = await handlePlanningFailure({
      err: error('operation-aborted', 'the operator left the parked run'),
      projectDir,
      sessionId,
      state: parked,
      wctx: makeWctx({ projectDir, sessionId, bus }),
    });

    expect(result).toMatchObject({ disposition: 'terminal', outcome: 'interrupted' });
    expect(result.state.interruptedStep).toEqual(parked.interruptedStep);
    expect(loadState({ projectDir, sessionId })?.interruptedStep).toEqual(parked.interruptedStep);
    expect(events.some((event) => event.type === 'turn_interrupted')).toBe(false);
  });

  it('End run during a planner call parks nothing and records no stop', async () => {
    const { projectDir, sessionId } = setupProject();
    const state = { ...createInitialState('feature'), phase: 'planning' as const };
    saveState({ projectDir, sessionId }, state);
    const { bus, events } = makeBusRecorder();
    const controller = new AbortController();
    controller.abort(WORKFLOW_USER_CANCELLED_ABORT_REASON);

    const result = await handlePlanningFailure({
      err: abortError(controller.signal),
      projectDir,
      sessionId,
      state,
      wctx: makeWctx({ projectDir, sessionId, bus, signal: controller.signal }),
    });

    expect(result).toMatchObject({ disposition: 'terminal', outcome: 'cancelled' });
    expect(result.state.interruptedStep).toBeUndefined();
    expect(loadState({ projectDir, sessionId })?.interruptedStep).toBeUndefined();
    expect(events.some((event) => event.type === 'turn_interrupted')).toBe(false);
  });

  it('rebases the halt after planner usage booking so the paid usage remains persisted', async () => {
    const { projectDir, sessionId } = setupProject();
    const staleState = { ...createInitialState('feature'), phase: 'planning' as const };
    saveState({ projectDir, sessionId }, staleState);
    const { bus } = makeBusRecorder();

    addUsageAndSave({ projectDir, sessionId, bus }, staleState, 'planner', {
      inputTokens: 125,
      outputTokens: 40,
    });

    const result = await handlePlanningFailure({
      err: error('planning-parse-failed', 'planner output could not be parsed'),
      projectDir,
      sessionId,
      state: staleState,
      wctx: makeWctx({ projectDir, sessionId }),
    });

    expect(result).toMatchObject({ disposition: 'terminal', outcome: 'halted' });
    expect(result.state.phase).toBe('planning');
    expect(result.state.tokenUsage).toMatchObject({ plannerInput: 125, plannerOutput: 40 });
    expect(loadState({ projectDir, sessionId })?.tokenUsage).toMatchObject({
      plannerInput: 125,
      plannerOutput: 40,
    });
  });

  it('raises a plan-seat recovery the operator can answer', async () => {
    const { projectDir, sessionId } = setupProject();
    const state = { ...createInitialState('feature'), phase: 'planning' as const };
    saveState({ projectDir, sessionId }, state);

    const result = await handlePlanningFailure({
      err: error('planning-parse-failed', 'planner output could not be parsed'),
      projectDir,
      sessionId,
      state,
      wctx: makeWctx({ projectDir, sessionId }),
    });

    const issue = result.state.pendingRecovery;
    expect(issue?.reason).toBe('planner-call-failed');
    expect(issue?.seat).toBe('plan');
    expect(issue?.phase).toBe('planning');
    expect(issue?.availableActions).toEqual(['retry-same-worker', 'end-run']);
    expect(issue?.recommendedAction).toBe('retry-same-worker');
    expect(loadState({ projectDir, sessionId })?.pendingRecovery?.reason).toBe(
      'planner-call-failed',
    );
  });

  it('surfaces the planner tool diagnosis and the login command for an auth failure', async () => {
    const { projectDir, sessionId } = setupProject();
    const state = { ...createInitialState('feature'), phase: 'planning' as const };
    const { bus, events } = makeBusRecorder();
    // Captured verbatim from `codex exec --json` (codex-cli 0.146.0, 2026-08-06);
    // the planner wraps it exactly like requireCompletedCall does.
    const codexMessage =
      'Your access token could not be refreshed because your refresh token was already used. Please log out and sign in again.';
    const err = error('runner-call-failed', 'Planner planner call failed', {
      status: 'failed',
      error: { code: 'codex-turn-failed', message: codexMessage },
    });

    const result = await handlePlanningFailure({
      err,
      projectDir,
      sessionId,
      state,
      wctx: makeWctx({
        projectDir,
        sessionId,
        bus,
        config: makeConfig({
          planner: { kind: 'cli', tool: 'codex', authChannel: defaultCliAuthChannel('codex').id },
        }),
      }),
    });

    expect(result).toMatchObject({ disposition: 'terminal', outcome: 'halted' });
    expect(result.state.pendingRecovery?.reason).toBe('runner-unauthenticated');
    const published = events.find((event) => event.type === 'error');
    expect(published?.type === 'error' && published.message).toContain(codexMessage);
    expect(published?.type === 'error' && published.message).toContain('codex logout');
    expect(published?.type === 'error' && published.message).toContain('codex login');
  });

  it('surfaces the reset time for a planner usage limit instead of login advice', async () => {
    const { projectDir, sessionId } = setupProject();
    const state = { ...createInitialState('feature'), phase: 'planning' as const };
    const { bus, events } = makeBusRecorder();
    // Captured live from `codex exec --json` on 2026-08-06 against an account
    // at its usage limit; the planner wraps it exactly like requireCompletedCall does.
    const codexLimit =
      "You've hit your usage limit. Visit https://chatgpt.com/codex/settings/usage to purchase more credits or try again at Aug 8th, 2026 3:27 PM.";
    const err = error('runner-call-failed', 'Planner planner call failed', {
      status: 'failed',
      error: { code: 'codex-turn-failed', message: codexLimit },
    });

    const result = await handlePlanningFailure({
      err,
      projectDir,
      sessionId,
      state,
      wctx: makeWctx({
        projectDir,
        sessionId,
        bus,
        config: makeConfig({
          planner: { kind: 'cli', tool: 'codex', authChannel: defaultCliAuthChannel('codex').id },
        }),
      }),
    });

    expect(result).toMatchObject({ disposition: 'terminal', outcome: 'halted' });
    expect(result.state.pendingRecovery?.reason).toBe('runner-usage-limit');
    expect(result.state.pendingRecovery?.resetAt).toBeDefined();
    expect(result.state.pendingRecovery?.details).toEqual([
      `OpenAI Codex CLI reported: ${codexLimit}`,
      'no fallback set',
    ]);
    // The error row carries the halt's reset for the row to spell; its words name no clock, and
    // codex's own words drop theirs.
    const published = events.find((event) => event.type === 'error');
    expect(published?.type === 'error' && published.resetAt).toBe(
      result.state.pendingRecovery?.resetAt,
    );
    const row = published?.type === 'error' ? published.message : '';
    expect(row).not.toMatch(/15:27|3:27 PM|try again/);
    expect(row).not.toContain('codex login');
    expect(row).not.toContain('codex logout');
  });

  it('a halted planner call keeps its phase so the step can be re-issued', async () => {
    const { projectDir, sessionId } = setupProject();
    const state = { ...createInitialState('feature'), phase: 'planning' as const };
    const { bus, events } = makeBusRecorder();
    const err = error('runner-call-failed', 'Planner planner call failed', {
      status: 'failed',
      error: {
        code: 'codex-turn-failed',
        message: "You've hit your usage limit. Try again at Aug 8th, 2026 3:27 PM.",
      },
    });

    const result = await handlePlanningFailure({
      err,
      projectDir,
      sessionId,
      state,
      wctx: makeWctx({ projectDir, sessionId, bus }),
    });

    expect(result.state.phase).toBe('planning');
    expect(result.state.closed).toBeUndefined();
    // The halt keeps this run open: `start` would open a second run, so the words say continue.
    const published = events.find((event) => event.type === 'error');
    expect(published?.type === 'error' && published.message).toContain('then continue');
    expect(published?.type === 'error' && published.message).not.toContain('start again');
    expect(published?.type === 'error' && published.message).not.toContain('..');
  });
});

type InvokePlan = PlannerBaseConfig['invokePlan'];
type InvokeInput = Parameters<InvokePlan>[0];

function untilAborted(signal: AbortSignal | undefined): Promise<void> {
  if (signal === undefined) throw new Error('The planner call carries no signal');
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) =>
    signal.addEventListener('abort', () => resolve(), { once: true }),
  );
}

// The result process-invoke returns when its signal ends the call: every CLI
// adapter tool (codex, opencode, cursor, kilo-code, antigravity, command-code,
// copilot) plans through it, and `requireCompletedCall` wraps it.
function cliAdapterCall(timeoutMs?: number) {
  return async (input: InvokeInput, inFlight: () => void) => {
    const own = composeAbortSignal(input.signal, timeoutMs);
    inFlight();
    await untilAborted(own);
    const status = runnerCallInterruptedStatus(own);
    return makeRunnerCallResult({
      callId: input.callContext.callId,
      role: 'planner',
      backendKind: 'cli',
      status,
      text: '',
      error:
        status === 'timeout'
          ? { code: 'timeout', message: 'CLI invocation timed out' }
          : { code: 'runner_interrupted', message: 'stopped by you' },
    });
  };
}

// The claude-code planner throws what `interruptedError` makes of its signal.
function claudeCodeCall(timeoutMs?: number) {
  return async (input: InvokeInput, inFlight: () => void): Promise<never> => {
    const own = composeAbortSignal(input.signal, timeoutMs);
    inFlight();
    await untilAborted(own);
    throw interruptedError(own, new Error('claude exited'));
  };
}

// An `api` planner streams through `streamCompletion`; this endpoint sends one
// delta and then holds the response open until the request is aborted.
async function apiCall(input: InvokeInput, inFlight: () => void) {
  let delivered = false;
  const client: Parameters<typeof streamCompletion>[0] = {
    chat: {
      completions: {
        create: async (_body, options) => ({
          [Symbol.asyncIterator]: () => ({
            next: async () => {
              if (!delivered) {
                delivered = true;
                return { done: false, value: { choices: [{ delta: { content: '# Research' } }] } };
              }
              inFlight();
              await untilAborted(options?.signal ?? undefined);
              throw options?.signal?.reason;
            },
          }),
        }),
      },
    },
  };
  return streamCompletion(client, 'planner-model', [{ role: 'user', content: input.prompt }], {
    temperature: 0,
    onProgress: input.callbacks.onOutput,
    ...(input.signal !== undefined && { signal: input.signal }),
  });
}

function scriptedPlanner(
  call: (input: InvokeInput, inFlight: () => void) => ReturnType<InvokePlan>,
  inFlight: () => void,
): Planner {
  const base = createPlannerBase({
    invokePlan: (input) => call(input, inFlight),
    invokeOneShot: () => Promise.reject(new Error('the planning session escalates nothing')),
    isAvailable: async () => true,
    capabilities: makePlanner().capabilities,
  });
  return makePlanner({ typedCall: base.typedCall });
}

// A real shell planner: `sleep` holds the call open until the stop kills it.
function shellPlanner(inFlight: () => void): Planner {
  const shell = createShellPlanner(
    makeConfig({ planner: { kind: 'shell', command: 'bash', args: ['-c', 'sleep 30'] } }),
  );
  return {
    ...shell,
    typedCall: (ctx) =>
      shell.typedCall({
        ...ctx,
        callbacks: {
          ...ctx.callbacks,
          onCallEvent: (event) => {
            if (event.type === 'call_started') inFlight();
            ctx.callbacks.onCallEvent?.(event);
          },
        },
      }),
  };
}

async function runFirstPlannerCall(
  planner: (inFlight: () => void) => Planner,
  opts: { stop: boolean },
) {
  const { projectDir, sessionId } = setupProject();
  const state: WorkflowState = {
    ...transition(createInitialState('feature'), { type: 'START' }),
    mode: 'standard',
    approve: 'none',
  };
  saveState({ projectDir, sessionId }, state);
  const { bus, events } = makeBusRecorder();
  const controller = new AbortController();
  const wctx: PlannerCallbacksContext = {
    projectDir,
    sessionId,
    config: makeConfig(),
    callbacks: makeCallbacks().callbacks,
    bus,
    metadata: TEST_METADATA,
    sinks: TEST_SINKS,
    signal: controller.signal,
  };
  let markInFlight: () => void = () => {};
  const inFlight = new Promise<void>((resolve) => {
    markInFlight = resolve;
  });
  const running = runPlanningSession({
    wctx,
    state,
    planner: planner(markInFlight),
    feature: state.feature,
  });
  await inFlight;
  if (opts.stop) controller.abort();
  const result = await running;
  const saved = loadState({ projectDir, sessionId });
  if (saved === null) throw new Error('Missing state');
  const status = deriveRunStatus({ state: saved, liveness: 'not-alive' });
  return { result, saved, status, events };
}

describe('a stop during a planner call', () => {
  const stops: Array<[string, (inFlight: () => void) => Planner]> = [
    ['a CLI adapter tool', (inFlight) => scriptedPlanner(cliAdapterCall(), inFlight)],
    ['an api endpoint', (inFlight) => scriptedPlanner(apiCall, inFlight)],
    ['claude-code', (inFlight) => scriptedPlanner(claudeCodeCall(), inFlight)],
    ['a shell command', shellPlanner],
  ];

  it.each(stops)('on %s parks the step the way a user stop does', async (_form, planner) => {
    const { result, saved, status, events } = await runFirstPlannerCall(planner, { stop: true });

    expect(result).toMatchObject({ disposition: 'terminal', outcome: 'interrupted' });
    expect(saved.pendingRecovery).toBeUndefined();
    expect(saved.interruptedStep).toMatchObject({
      step: { kind: 'planner', call: 'plan' },
      source: 'user',
      cut: 'mid-step',
    });
    expect(status).toEqual({
      kind: 'open',
      stop: { kind: 'stopped', on: { kind: 'paused', at: 'mid-step' } },
      resumeAt: { kind: 'planner', call: 'plan' },
    });
    expect(events.some((event) => event.type === 'error')).toBe(false);
  });

  const timeouts: Array<[string, (inFlight: () => void) => Planner]> = [
    ['a CLI adapter tool', (inFlight) => scriptedPlanner(cliAdapterCall(20), inFlight)],
    ['claude-code', (inFlight) => scriptedPlanner(claudeCodeCall(20), inFlight)],
  ];

  it.each(timeouts)('a timeout on %s still halts as a failed call', async (_form, planner) => {
    const { result, saved, status } = await runFirstPlannerCall(planner, { stop: false });

    expect(result).toMatchObject({ disposition: 'terminal', outcome: 'halted' });
    expect(saved.interruptedStep).toBeUndefined();
    expect(saved.pendingRecovery?.reason).toBe('planner-call-failed');
    expect(status).toMatchObject({
      kind: 'open',
      stop: { kind: 'waiting-for-you', on: { kind: 'halt' } },
    });
  });
});
