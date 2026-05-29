import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { render } from 'ink-testing-library';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createTempDir, cleanupTempDir } from '#testing/helpers/temp-dir.js';
import { makeSession } from '#testing/helpers/factories/session.js';
import { makeSummary } from '#testing/helpers/factories/summary.js';
import { DIPTYCH_DIR } from '../../core/paths.js';
import { createInitialState } from '../../core/state/machine.js';
import { saveState } from '../../core/state/persistence.js';
import { sessionsStore } from '../../stores/project/sessions.js';
import { configStore } from '../../stores/project/config.js';
import { overlayStore } from '../../stores/ui/overlay.js';
import { routerStore } from '../../stores/navigation/router.js';
import { feedbackStore } from '../../stores/ui/feedback.js';
import type { Session } from '../../core/schemas/session.js';
import { SessionsPicker } from './picker.js';
import { tick } from '#testing/helpers/ink.js';
import { handleSessionSelect } from './picker-select.js';

let tmp: string;

function writeSessionSummary(projectDir: string, session: Session): void {
  const dir = join(projectDir, DIPTYCH_DIR, 'sessions', session.id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'summary.json'), JSON.stringify(session));
}

beforeEach(() => {
  tmp = createTempDir('sessions-picker-test');
  sessionsStore.reset();
  configStore.reset();
  overlayStore.reset();
  routerStore.reset();
  feedbackStore.reset();
  // Seed configStore with a real tmpDir projectDir via real load (defaults ok).
  configStore.load(tmp);
});

afterEach(() => {
  if (tmp) cleanupTempDir(tmp);
  sessionsStore.reset();
  configStore.reset();
  overlayStore.reset();
  routerStore.reset();
  feedbackStore.reset();
});

describe('SessionsPicker', () => {
  it('renders session feature names from disk once the store loads them', async () => {
    writeSessionSummary(
      tmp,
      makeSession({
        id: 'sess-alpha',
        feature: 'add authentication',
        status: 'interrupted',
        summary: null,
      }),
    );
    writeSessionSummary(
      tmp,
      makeSession({
        id: 'sess-beta',
        feature: 'refactor payments',
        status: 'interrupted',
        summary: null,
      }),
    );

    const instance = render(<SessionsPicker />);
    await tick(1);
    await tick(1);

    // User-observable: the features appear in the rendered frame.
    const frame = instance.lastFrame() ?? '';
    expect(frame).toContain('add authentication');
    expect(frame).toContain('refactor payments');
    // Title reflects the number of sessions loaded from disk.
    expect(frame).toContain('(2)');

    instance.unmount();
  });

  it('shows an empty-state hint when there are no sessions on disk', async () => {
    const instance = render(<SessionsPicker />);
    await tick(1);
    await tick(1);

    const frame = instance.lastFrame() ?? '';
    expect(frame).toContain('(0)');
    expect(frame.toLowerCase()).toMatch(/no.*sessions/);

    instance.unmount();
  });
});

/**
 * handleSessionSelect is the routing logic triggered by Enter on a row. We test it by
 * invoking the real function against real stores — no internal mocks.
 * The three branches of the union (interrupted / complete-with-summary /
 * failed-without-summary) are the user-observable decisions the feature makes.
 */
describe('SessionsPicker handleSessionSelect (Enter routing)', () => {
  it('navigates to the workflow screen with saved state for an interrupted session', () => {
    overlayStore.open('sessions');
    const session = makeSession({
      id: 'sess-resume',
      feature: 'add auth',
      status: 'interrupted',
      summary: null,
    });
    const savedState = { ...createInitialState('saved add auth'), phase: 'implementing' as const };
    saveState(tmp, session.id, savedState);

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
    // The picker can sit on top of the workflow screen; workflow→summary is a valid transition.
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

    // Overlay still open and router unchanged — user stays on the picker.
    expect(overlayStore.get().active).toBe('sessions');
    expect(routerStore.get().screen).toBe('home');
    expect(feedbackStore.get().message ?? '').toContain('add auth');
  });
});
