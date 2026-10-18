import { createElement } from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { App, type AppProps } from '../../../src/app/root.js';
import { canonicalizeProjectDir } from '../../../src/cli/setup.js';
import { createDraftDocument } from '../../../src/core/composer/document.js';
import { loadConfig } from '../../../src/core/config/load/io.js';
import type { Summary } from '../../../src/core/schemas/summary.js';
import { readActive } from '../../../src/core/sessions/active-pointer.js';
import { readRunRecord } from '../../../src/core/sessions/run-record-io.js';
import { loadState } from '../../../src/core/state/persistence.js';
import { readRunEvents } from '../../../src/engine/events/replay.js';
import type { WorkflowScreenDeps } from '../../../src/features/workflow/hooks/workflow-screen/use-model.js';
import { hydrateRun } from '../../../src/features/workflow/run-history.js';
import { PROMPT_TYPEAHEAD_GRACE_MS } from '../../../src/lib/terminal/typeahead-grace.js';
import { routerStore } from '../../../src/stores/navigation/router.js';
import { configStore } from '../../../src/stores/project/config.js';
import { completionStore } from '../../../src/stores/ui/completion.js';
import { feedbackStore } from '../../../src/stores/ui/feedback.js';
import { flushSessionDrafts, saveSessionDraft } from '../../../src/stores/ui/session-drafts.js';
import { terminalSizeStore } from '../../../src/stores/ui/terminal-size.js';
import { stripAnsiStyles } from '#testing/helpers/ansi.js';
import { flushEffects, renderFeature, tick } from '#testing/helpers/ink.js';
import { resetAllStores } from '#testing/helpers/stores.js';
import { cleanupTempDir } from '#testing/helpers/temp-dir.js';
import { prepareWorkflowExecution } from '#testing/helpers/workflow-screen.js';
import {
  cli,
  createStopContinueFixture,
  escapingImplementerScript,
  type StopContinueFixture,
} from '../helpers/stop-continue-fixture.js';

const VIEWPORT = { cols: 120, rows: 40 };

let fixture: StopContinueFixture | undefined;
let ui: ReturnType<typeof renderFeature> | undefined;

afterEach(() => {
  ui?.unmount();
  ui = undefined;
  resetAllStores();
  vi.unstubAllEnvs();
  if (fixture !== undefined) cleanupTempDir(fixture.tmpDir);
  fixture = undefined;
});

async function openHaltedRun(draft?: string) {
  fixture = createStopContinueFixture(escapingImplementerScript);
  const halted = await cli(fixture, ['start', 'smoke']);
  expect(halted.exitCode, halted.stderr).toBe(1);
  vi.stubEnv('XDG_STATE_HOME', fixture.stateHome);
  const projectDir = await canonicalizeProjectDir({ project: fixture.projectDir });
  const sessionId = readActive(projectDir);
  if (sessionId === null) throw new Error('The halted run saved no session');
  const ref = { projectDir, sessionId };
  const state = loadState(ref);
  if (state === null) throw new Error('The halted run saved no state');
  expect(state.pendingRecovery?.reason).toBe('checkout-changed');
  if (draft !== undefined) {
    saveSessionDraft(ref, createDraftDocument(draft));
    flushSessionDrafts();
  }
  const record = readRunRecord(ref);
  const { config } = loadConfig(projectDir);
  configStore.__testReset({ projectDir, config, diskConfig: config });
  terminalSizeStore.__testReset({ ...VIEWPORT, isSmall: false });
  await hydrateRun(record);
  const prepared = prepareWorkflowExecution({
    projectDir,
    sessionId,
    config,
    feature: state.feature,
    resumeState: state,
  });
  routerStore.init({ screen: 'workflow', run: record, execution: { kind: 'local', prepared } });
  const runWorkflow = vi.fn(() => new Promise<Summary>(() => {}));
  const workflowDeps: WorkflowScreenDeps = { runWorkflow };
  ui = renderFeature(createElement<AppProps>(App, { workflowDeps }), VIEWPORT);
  const screen = ui;
  await vi.waitFor(() => expect(stripAnsiStyles(screen.lastFrame())).toContain('Needs you'));
  await tick(PROMPT_TYPEAHEAD_GRACE_MS + 30);
  await flushEffects();
  return { screen, ref, state, runWorkflow };
}

it('runs /scroll top typed under a recovery menu and never takes it as the correction', async () => {
  const { screen, ref, state, runWorkflow } = await openHaltedRun();
  screen.stdin.write('\t');
  await flushEffects();
  screen.stdin.write('/scr');
  await flushEffects();
  expect(stripAnsiStyles(screen.lastFrame())).toContain('/scroll  Scroll conversation');
  // Past a finished argument the list closes, and the panel says what ⏎ does with the draft.
  screen.stdin.write('oll top ');
  await flushEffects();
  const drafted = stripAnsiStyles(screen.lastFrame());
  expect(drafted).toContain('⏎ runs the command · tab back to the actions');
  expect(drafted).not.toContain('typed correction');
  screen.stdin.write('\r');
  await vi.waitFor(() =>
    expect(feedbackStore.get()).toEqual({
      message: 'Scrolled conversation to top',
      isError: false,
    }),
  );
  await flushEffects();

  expect(stripAnsiStyles(screen.lastFrame())).toContain('Needs you');
  expect(runWorkflow).not.toHaveBeenCalled();
  const saved = loadState(ref);
  expect(saved?.pendingRecovery?.id).toBe(state.pendingRecovery?.id);
  expect(saved?.messageQueue.map((message) => message.text)).not.toContain('/scroll top');
  const { events } = await readRunEvents(ref);
  expect(events.filter((event) => event.type === 'recovery_action_selected')).toEqual([]);
});

it('paints no command list from a saved slash draft while the recovery menu holds focus', async () => {
  const { screen } = await openHaltedRun('/scr');
  const frame = stripAnsiStyles(screen.lastFrame());
  expect(frame).not.toContain('Scroll conversation');
  expect(frame).toContain('tab type a correction');
  expect(completionStore.get().open).toBe(false);

  screen.stdin.write('\x1b');
  await vi.waitFor(() => expect(stripAnsiStyles(screen.lastFrame())).toContain('Stop options'));
});
