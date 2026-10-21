import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { stripAnsiStyles } from '#testing/helpers/ansi.js';
import { makeConfig } from '#testing/helpers/factories/config.js';
import { makeRunRecord } from '#testing/helpers/factories/run-record.js';
import { makeSession } from '#testing/helpers/factories/session.js';
import { flushEffects, renderFeature, tick } from '#testing/helpers/ink.js';
import { resetAllStores } from '#testing/helpers/stores.js';
import { cleanupTempDir, createTempDir } from '#testing/helpers/temp-dir.js';
import { APPLY_RUNNING_REFUSAL } from '../core/runtime/commands/messages.js';
import { saveSummary } from '../core/sessions/io.js';
import {
  activeApply,
  trackActiveApply,
} from '../engine/orchestrator/session-lifecycle/shutdown.js';
import { buildPaletteSources } from '../features/palette/sources.js';
import { handleSessionSelect, sessionSelectStore } from '../stores/navigation/session-select.js';
import { routerStore } from '../stores/navigation/router.js';
import { configStore } from '../stores/project/config.js';
import { sessionsStore } from '../stores/project/sessions.js';
import { feedbackStore } from '../stores/ui/feedback.js';
import { overlayStore } from '../stores/ui/overlay.js';
import { terminalSizeStore } from '../stores/ui/terminal-size.js';
import { sessionSelectDeps } from './prepare-resume.js';
import { App } from './root.js';

const VIEWPORT = { cols: 120, rows: 40 };
const FEATURE = 'Add generated JSON data fixtures';

describe('App: the claim that Apply is still writing', () => {
  let projectDir = '';
  let finishApply: () => void = () => {};

  beforeEach(() => {
    resetAllStores();
    projectDir = createTempDir('app-apply-claim');
    configStore.__testReset({ config: makeConfig(), projectDir });
    terminalSizeStore.__testReset({ ...VIEWPORT, isSmall: false });
    const session = makeSession({
      id: 'other-run',
      feature: FEATURE,
      status: 'open',
      summary: null,
    });
    saveSummary({ projectDir, sessionId: session.id }, session);
    sessionsStore.load(projectDir);
    routerStore.navigate({
      to: 'workflow',
      run: makeRunRecord({
        ref: { projectDir, sessionId: 'applied-run' },
        status: { kind: 'closed', as: 'applied' },
      }),
      execution: { kind: 'at-rest' },
    });
    const apply = Promise.withResolvers<void>();
    finishApply = apply.resolve;
    void trackActiveApply(apply.promise);
  });

  afterEach(async () => {
    finishApply();
    await activeApply();
    resetAllStores();
    cleanupTempDir(projectDir);
  });

  async function endApply(): Promise<void> {
    finishApply();
    await activeApply();
    await flushEffects();
  }

  it('leaves the footer and the selection the moment Apply ends', async () => {
    const ui = renderFeature(<App />, VIEWPORT);
    await tick(5);
    const sources = buildPaletteSources({
      commands: [],
      screen: 'workflow',
      config: makeConfig(),
      phase: 'idle',
      tasks: [],
      sessions: sessionsStore.get().sessions,
      projectDir,
      onRuntimeCommand: () => undefined,
      onSessionSelect: (session, dir) => handleSessionSelect(session, dir, sessionSelectDeps),
    });
    const pick = sources.sessionItems[0];
    if (pick === undefined) throw new Error('expected the session in the palette');
    await pick.action();
    await vi.waitFor(() =>
      expect(stripAnsiStyles(ui.lastFrame() ?? '')).toContain(APPLY_RUNNING_REFUSAL),
    );

    await endApply();

    expect(feedbackStore.get().message).toBeNull();
    expect(sessionSelectStore.get().error).toBeNull();
    await vi.waitFor(() =>
      expect(stripAnsiStyles(ui.lastFrame() ?? '')).not.toContain(APPLY_RUNNING_REFUSAL),
    );
    ui.unmount();
  });

  it('leaves the Sessions panel the moment Apply ends', async () => {
    overlayStore.open('sessions');
    const ui = renderFeature(<App />, VIEWPORT);
    await tick(5);
    await flushEffects();
    ui.stdin.write('\r');
    await vi.waitFor(() =>
      expect(stripAnsiStyles(ui.lastFrame() ?? '')).toContain(APPLY_RUNNING_REFUSAL),
    );

    await endApply();

    await vi.waitFor(() =>
      expect(stripAnsiStyles(ui.lastFrame() ?? '')).not.toContain(APPLY_RUNNING_REFUSAL),
    );
    expect(overlayStore.get().active).toBe('sessions');
    expect(sessionSelectStore.get().error).toBeNull();
    ui.unmount();
  });

  it('takes back a command refusal when Apply ends', async () => {
    const ui = renderFeature(<App />, VIEWPORT);
    await tick(5);
    feedbackStore.setError(APPLY_RUNNING_REFUSAL);

    await endApply();

    expect(feedbackStore.get().message).toBeNull();
    ui.unmount();
  });

  it('keeps a feedback line that is not about Apply', async () => {
    const ui = renderFeature(<App />, VIEWPORT);
    await tick(5);
    feedbackStore.setError('Connection lost');

    await endApply();

    expect(feedbackStore.get()).toEqual({ message: 'Connection lost', isError: true });
    ui.unmount();
  });
});
