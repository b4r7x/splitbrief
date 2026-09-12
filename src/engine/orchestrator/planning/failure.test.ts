import { afterEach, describe, expect, it } from 'vitest';
import { makeBusRecorder, makeWctx } from '#testing/helpers/orchestrator-factories.js';
import { makeConfig } from '#testing/helpers/factories/config.js';
import { cleanupTempDir, createTempDir } from '#testing/helpers/temp-dir.js';
import { defaultCliAuthChannel } from '../../../core/runners/cli-tool-catalog.js';
import { ensureSessionDir } from '../../../core/paths-io.js';
import { createInitialState } from '../../../core/state/machine.js';
import { loadState, saveState } from '../../../core/state/persistence.js';
import { error } from '../../../utils/error.js';
import { addUsageAndSave } from '../state-ops.js';
import { handlePlanningFailure } from './failure.js';

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
  it('aborted planning publishes no `error` event; non-abort failures still do', () => {
    const { projectDir, sessionId } = setupProject();
    const state = { ...createInitialState('feature'), phase: 'planning' as const };
    const { bus: abortBus, events: abortEvents } = makeBusRecorder();

    handlePlanningFailure({
      err: error('operation-aborted', 'workflow-rewind'),
      projectDir,
      sessionId,
      state,
      wctx: makeWctx({ projectDir, sessionId, bus: abortBus }),
    });

    expect(abortEvents.some((event) => event.type === 'error')).toBe(false);

    const { bus: failBus, events: failEvents } = makeBusRecorder();
    handlePlanningFailure({
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

  it('preserves the persisted rewind request when planning aborts', () => {
    const { projectDir, sessionId } = setupProject();
    const staleState = { ...createInitialState('feature'), phase: 'planning' as const };
    const persistedState = {
      ...staleState,
      rewindPending: { target: 'plan' as const, comment: 'rewind to the plan' },
    };
    saveState({ projectDir, sessionId }, persistedState);

    const wctx = makeWctx({ projectDir, sessionId });

    const result = handlePlanningFailure({
      err: error('operation-aborted', 'approval gate cancelled'),
      projectDir,
      sessionId,
      state: staleState,
      wctx,
    });

    expect(result).toMatchObject({ disposition: 'terminal', outcome: 'cancelled' });
    expect(result.state.rewindPending).toEqual({
      target: 'plan',
      comment: 'rewind to the plan',
    });
    expect(loadState({ projectDir, sessionId })?.rewindPending).toEqual({
      target: 'plan',
      comment: 'rewind to the plan',
    });
    expect(loadState({ projectDir, sessionId })?.phase).toBe('idle');
  });

  it('rebases cancellation after planner usage booking so the paid usage remains persisted', () => {
    const { projectDir, sessionId } = setupProject();
    const staleState = { ...createInitialState('feature'), phase: 'planning' as const };
    saveState({ projectDir, sessionId }, staleState);
    const { bus } = makeBusRecorder();

    addUsageAndSave({ projectDir, sessionId, bus }, staleState, 'planner', {
      inputTokens: 125,
      outputTokens: 40,
    });

    const result = handlePlanningFailure({
      err: error('planning-parse-failed', 'planner output could not be parsed'),
      projectDir,
      sessionId,
      state: staleState,
      wctx: makeWctx({ projectDir, sessionId }),
    });

    expect(result).toMatchObject({ disposition: 'terminal', outcome: 'failed' });
    expect(result.state.phase).toBe('idle');
    expect(result.state.tokenUsage).toMatchObject({ plannerInput: 125, plannerOutput: 40 });
    expect(loadState({ projectDir, sessionId })?.tokenUsage).toMatchObject({
      plannerInput: 125,
      plannerOutput: 40,
    });
  });

  it('surfaces the planner tool diagnosis and the login command for an auth failure', () => {
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

    const result = handlePlanningFailure({
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

    expect(result).toMatchObject({ disposition: 'terminal', outcome: 'failed' });
    const published = events.find((event) => event.type === 'error');
    expect(published?.type === 'error' && published.message).toContain(codexMessage);
    expect(published?.type === 'error' && published.message).toContain('codex logout');
    expect(published?.type === 'error' && published.message).toContain('codex login');
  });

  it('surfaces the reset time for a planner usage limit instead of login advice', () => {
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

    const result = handlePlanningFailure({
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

    expect(result).toMatchObject({ disposition: 'terminal', outcome: 'failed' });
    const published = events.find((event) => event.type === 'error');
    expect(published?.type === 'error' && published.message).toContain(codexLimit);
    expect(published?.type === 'error' && published.message).toContain('hit its usage limit');
    expect(published?.type === 'error' && published.message).toContain('Aug 8, 2026, 3:27 PM');
    expect(published?.type === 'error' && published.message).not.toContain('codex login');
    expect(published?.type === 'error' && published.message).not.toContain('codex logout');
  });
});
