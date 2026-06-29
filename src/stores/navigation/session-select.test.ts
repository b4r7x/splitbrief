import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTempDir, cleanupTempDir } from '#testing/helpers/temp-dir.js';
import { makeSession } from '#testing/helpers/factories/session.js';
import { makeSummary } from '#testing/helpers/factories/summary.js';
import { createInitialState } from '../../core/state/machine.js';
import { saveState } from '../../core/state/persistence.js';
import { configStore } from '../project/config.js';
import { overlayStore } from '../ui/overlay.js';
import { routerStore } from './router.js';
import { handleSessionSelect, sessionSelectStore } from './session-select.js';

let tmp: string;

beforeEach(() => {
  tmp = createTempDir('session-select-test');
  configStore.reset();
  overlayStore.reset();
  routerStore.reset();
  sessionSelectStore.reset();
  configStore.load(tmp);
});

afterEach(() => {
  if (tmp) cleanupTempDir(tmp);
  configStore.reset();
  overlayStore.reset();
  routerStore.reset();
  sessionSelectStore.reset();
});

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
    expect(sessionSelectStore.get().error).toBeNull();
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
    const { error } = sessionSelectStore.get();
    expect(error ?? '').toContain('interrupted before it made progress');
    expect(error ?? '').toContain('add auth');
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
    expect(sessionSelectStore.get().error ?? '').toContain('saved workflow state');
  });

  it('opens an interrupted session summary when no resumable state is available', () => {
    overlayStore.open('sessions');
    const summary = makeSummary({ feature: 'partial refactor' });
    const session = makeSession({
      id: 'sess-interrupted-summary',
      feature: 'partial refactor',
      status: 'interrupted',
      summary,
    });

    handleSessionSelect(session, tmp);

    expect(overlayStore.get().active).toBe('none');
    const route = routerStore.get();
    expect(route.screen).toBe('summary');
    if (route.screen === 'summary') {
      expect(route.summary).toEqual(summary);
      expect(route.sessionId).toBe('sess-interrupted-summary');
      expect(route.status).toBe('interrupted');
    }
    expect(sessionSelectStore.get().error).toBeNull();
  });

  it('navigates from home to the summary screen when the session completed with a summary', () => {
    overlayStore.open('sessions');
    const summary = makeSummary({ feature: 'refactor payments' });
    const session = makeSession({ id: 'sess-complete', status: 'complete', summary });

    handleSessionSelect(session, tmp);

    expect(overlayStore.get().active).toBe('none');
    const route = routerStore.get();
    expect(route.screen).toBe('summary');
    if (route.screen === 'summary') {
      expect(route.summary).toEqual(summary);
      expect(route.sessionId).toBe('sess-complete');
      expect(route.status).toBe('complete');
    }
    expect(sessionSelectStore.get().error).toBeNull();
  });

  it('replaces an open summary when a failed session has a summary to display', () => {
    routerStore.init({
      screen: 'summary',
      summary: makeSummary({ feature: 'old summary' }),
      sessionId: 'old-session',
      status: 'complete',
    });
    overlayStore.open('sessions');
    const summary = makeSummary({ feature: 'failed feature' });
    const session = makeSession({
      id: 'failed-summary',
      feature: 'failed feature',
      status: 'failed',
      summary,
    });

    handleSessionSelect(session, tmp);

    expect(overlayStore.get().active).toBe('none');
    const route = routerStore.get();
    expect(route.screen).toBe('summary');
    if (route.screen === 'summary') {
      expect(route.summary).toEqual(summary);
      expect(route.sessionId).toBe('failed-summary');
      expect(route.status).toBe('failed');
    }
    expect(sessionSelectStore.get().error).toBeNull();
  });

  it('keeps the overlay open and surfaces feedback for a failed session without a summary', () => {
    overlayStore.open('sessions');
    const session = makeSession({ feature: 'add auth', status: 'failed', summary: null });

    handleSessionSelect(session, tmp);

    expect(overlayStore.get().active).toBe('sessions');
    expect(routerStore.get().screen).toBe('home');
    expect(sessionSelectStore.get().error ?? '').toContain('add auth');
  });

  it('strips OSC-52/CSI control bytes from the feature name interpolated into a selection error', () => {
    overlayStore.open('sessions');
    const payload = 'ZWNobyBwd25lZA==';
    const malicious = `before\u001b]52;c;${payload}\u0007\u001b[2Jafter`;
    const session = makeSession({ feature: malicious, status: 'failed', summary: null });

    handleSessionSelect(session, tmp);

    const error = sessionSelectStore.get().error ?? '';
    expect(error).toContain('beforeafter');
    expect(error).not.toContain(payload);
    expect(error).not.toContain(']52');
    expect(error).not.toContain('[2J');
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

    const { error } = sessionSelectStore.get();
    expect(error ?? '').toContain('add auth');
    expect(error ?? '').toContain('Cannot resume');
    expect(overlayStore.get().active).toBe('sessions');
    expect(routerStore.get().screen).toBe('home');
  });
});
