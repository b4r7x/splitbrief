import { afterEach, expect, it, vi } from 'vitest';
import { loadState } from '../../../src/core/state/persistence.js';
import { readRunEvents } from '../../../src/engine/events/replay.js';
import { completionStore } from '../../../src/stores/ui/completion.js';
import { feedbackStore } from '../../../src/stores/ui/feedback.js';
import { stripAnsiStyles } from '#testing/helpers/ansi.js';
import { flushEffects, type renderFeature } from '#testing/helpers/ink.js';
import { resetAllStores } from '#testing/helpers/stores.js';
import { cleanupTempDir } from '#testing/helpers/temp-dir.js';
import { openHaltedRun } from '../helpers/halted-run-screen.js';
import {
  cli,
  createStopContinueFixture,
  escapingImplementerScript,
  type StopContinueFixture,
} from '../helpers/stop-continue-fixture.js';

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

async function openCheckoutChangedRun(draft?: string) {
  fixture = createStopContinueFixture(escapingImplementerScript);
  const halted = await cli(fixture, ['start', 'smoke']);
  expect(halted.exitCode, halted.stderr).toBe(1);
  const opened = await openHaltedRun(fixture, { heading: 'Needs you', draft });
  ui = opened.screen;
  expect(opened.state.pendingRecovery?.reason).toBe('checkout-changed');
  return opened;
}

it('runs /scroll top typed under a recovery menu and never takes it as the correction', async () => {
  const { screen, ref, state, runWorkflow } = await openCheckoutChangedRun();
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
  const { screen } = await openCheckoutChangedRun('/scr');
  const frame = stripAnsiStyles(screen.lastFrame());
  expect(frame).not.toContain('Scroll conversation');
  expect(frame).toContain('tab type a correction');
  expect(completionStore.get().open).toBe(false);

  screen.stdin.write('\x1b');
  await vi.waitFor(() => expect(stripAnsiStyles(screen.lastFrame())).toContain('Stop options'));
});
