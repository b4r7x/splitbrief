import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTempDir, cleanupTempDir } from '#testing/helpers/temp-dir.js';
import { makeSession } from '#testing/helpers/factories/session.js';
import { makeSummary } from '#testing/helpers/factories/summary.js';
import { createInitialState } from '../../core/state/machine.js';
import { saveState } from '../../core/state/persistence.js';
import { configStore } from '../project/config.js';
import { overlayStore } from '../ui/overlay.js';
import { feedbackStore } from '../ui/feedback.js';
import { routerStore } from './router.js';
import { handleSessionSelect } from './session-select.js';

let tmp: string;

beforeEach(() => {
  tmp = createTempDir('session-select-test');
  configStore.reset();
  overlayStore.reset();
  routerStore.reset();
  feedbackStore.reset();
  configStore.load(tmp);
});

afterEach(() => {
  if (tmp) cleanupTempDir(tmp);
  configStore.reset();
  overlayStore.reset();
  routerStore.reset();
  feedbackStore.reset();
});

/**
 * handleSessionSelect is the routing logic triggered by Enter on a session row. We test it by
 * invoking the real function against real stores — no internal mocks. The three branches of the
 * union (interrupted / complete-with-summary / failed-without-summary) are the user-observable
 * decisions the feature makes.
 */
describe('handleSessionSelect (Enter routing)', () => {
  it('navigates to the workflow screen with saved state for an interrupted session', () => {
    overlayStore.open('sessions');
    const session = makeSession({
      id: 'sess-resume',
      feature: 'add auth',
      status: 'interrupted',
      summary: null,
    });
    const savedState = { ...createInitialState('saved add auth'), phase: 'implementing' as const };
    saveState({ projectDir: tmp, sessionId: session.id }, savedState);

    handleSessionSelect(session, tmp);

    expect(overlayStore.get().active).toBe('none');
    const route = routerStore.get();
    expect(route.screen).toBe('workflow');
    if (route.screen === 'workflow') {
      expect(route.feature).toBe('saved add auth');
      expect(route.resumeState).toEqual(savedState);
      expect(route.sessionId).toBe(session.id);
    }
    expect(feedbackStore.get().message).toBeNull();
  });

  it('refuses to resume an interrupted session whose saved state never reached a resumable phase', () => {
    overlayStore.open('sessions');
    const session = makeSession({
      id: 'sess-poisoned',
      feature: 'add auth',
      status: 'interrupted',
      summary: null,
    });
    const savedState = createInitialState('saved add auth');
    expect(savedState.phase).toBe('idle');
    saveState({ projectDir: tmp, sessionId: session.id }, savedState);

    handleSessionSelect(session, tmp);

    expect(overlayStore.get().active).toBe('sessions');
    expect(routerStore.get().screen).toBe('home');
    const feedback = feedbackStore.get();
    expect(feedback.isError).toBe(true);
    expect(feedback.message ?? '').toContain('interrupted before it made progress');
    expect(feedback.message ?? '').toContain('add auth');
  });

  it('keeps the picker open and surfaces feedback when an interrupted session has no valid state', () => {
    overlayStore.open('sessions');
    const session = makeSession({
      id: 'sess-missing-state',
      feature: 'add auth',
      status: 'interrupted',
      summary: null,
    });

    handleSessionSelect(session, tmp);

    expect(overlayStore.get().active).toBe('sessions');
    expect(routerStore.get().screen).toBe('home');
    const feedback = feedbackStore.get();
    expect(feedback.isError).toBe(true);
    expect(feedback.message ?? '').toContain('saved workflow state');
  });

  it('navigates to the summary screen when the session completed with a summary', () => {
    routerStore.navigate({ to: 'workflow', feature: 'existing' });
    overlayStore.open('sessions');
    const summary = makeSummary({ feature: 'refactor payments' });
    const session = makeSession({ status: 'complete', summary });

    handleSessionSelect(session, tmp);

    expect(overlayStore.get().active).toBe('none');
    const route = routerStore.get();
    expect(route.screen).toBe('summary');
    if (route.screen === 'summary') expect(route.summary).toEqual(summary);
    expect(feedbackStore.get().message).toBeNull();
  });

  it('keeps the overlay open and surfaces feedback for a failed session without a summary', () => {
    overlayStore.open('sessions');
    const session = makeSession({ feature: 'add auth', status: 'failed', summary: null });

    handleSessionSelect(session, tmp);

    expect(overlayStore.get().active).toBe('sessions');
    expect(routerStore.get().screen).toBe('home');
    expect(feedbackStore.get().message ?? '').toContain('add auth');
  });

  it('surfaces an error and stays on home when loadState throws for an interrupted session with an unsafe id', () => {
    overlayStore.open('sessions');
    const session = makeSession({
      id: 'bad/id',
      feature: 'add auth',
      status: 'interrupted',
      summary: null,
    });

    handleSessionSelect(session, tmp);

    const fb = feedbackStore.get();
    expect(fb.isError).toBe(true);
    expect(fb.message ?? '').toContain('add auth');
    expect(fb.message ?? '').toContain('Cannot resume');
    expect(overlayStore.get().active).toBe('sessions');
    expect(routerStore.get().screen).toBe('home');
  });
});
