import { afterEach, expect, it, onTestFinished, vi } from 'vitest';
import { loadState } from '../../../src/core/state/persistence.js';
import { readRunEvents } from '../../../src/engine/events/replay.js';
import { completionStore } from '../../../src/stores/ui/completion.js';
import { composerDraftStore } from '../../../src/stores/ui/composer-draft.js';
import { composerLiveStore } from '../../../src/stores/ui/composer-live.js';
import { feedbackStore } from '../../../src/stores/ui/feedback.js';
import { stripAnsiStyles } from '#testing/helpers/ansi.js';
import { flushEffects, type renderFeature } from '#testing/helpers/ink.js';
import { resetAllStores } from '#testing/helpers/stores.js';
import { cleanupTempDir } from '#testing/helpers/temp-dir.js';
import { glyph } from '../../../src/lib/glyphs.js';
import {
  consultFailureHaltFixture,
  dependentPlan,
  startToHalt,
} from '../helpers/consult-failure-halt.js';
import { openHaltedRun, settleOpenedRuns } from '../helpers/halted-run-screen.js';
import {
  cli,
  createStopContinueFixture,
  escapingImplementerScript,
  type StopContinueFixture,
} from '../helpers/stop-continue-fixture.js';

let fixture: StopContinueFixture | undefined;
let ui: ReturnType<typeof renderFeature> | undefined;

afterEach(async () => {
  ui?.unmount();
  ui = undefined;
  await settleOpenedRuns();
  resetAllStores();
  vi.unstubAllEnvs();
  if (fixture !== undefined) cleanupTempDir(fixture.tmpDir);
  fixture = undefined;
});

async function openCheckoutChangedRun(draft?: string) {
  fixture = createStopContinueFixture(escapingImplementerScript);
  const halted = await cli(fixture, ['start', 'smoke']);
  expect(halted.exitCode, halted.stderr).toBe(1);
  const opened = await openHaltedRun(fixture, {
    heading: draft === undefined ? 'Needs you' : 'Choose how to continue',
    draft,
  });
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
      severity: 'info',
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

// A menu that opens over a draft leaves the keys in the composer, so a saved slash draft is a live
// command line. An open list owns esc, and the next esc reaches the stop options.
it('leaves the keys and the command list with a saved slash draft when the recovery menu opens', async () => {
  const { screen } = await openCheckoutChangedRun('/scr');
  const frame = stripAnsiStyles(screen.lastFrame());
  expect(frame).toContain('/scroll  Scroll conversation');
  expect(frame).not.toContain('Needs you');
  expect(frame).not.toContain('tab type a correction');
  expect(completionStore.get().open).toBe(true);

  screen.stdin.write('\x1b');
  await vi.waitFor(() => expect(completionStore.get().open).toBe(false));
  await vi.waitFor(() => expect(stripAnsiStyles(screen.lastFrame())).toContain('Needs you'));
  screen.stdin.write('\x1b');
  await vi.waitFor(() => expect(stripAnsiStyles(screen.lastFrame())).toContain('Stop options'));
});

const NO_CORRECTION = 'This halt takes no typed correction. Choose an action.';

async function openDependencyBlockedRun(draft?: string) {
  const halt = consultFailureHaltFixture(dependentPlan);
  fixture = halt.fixture;
  onTestFinished(halt.restorePath);
  const sessionId = await startToHalt(halt.fixture);
  const skipped = await cli(halt.fixture, ['continue', sessionId, '--plain', '--action', 'skip']);
  expect(skipped.exitCode, `${skipped.stdout}\n${skipped.stderr}`).toBe(1);
  const opened = await openHaltedRun(halt.fixture, { heading: 'Needs you', draft });
  ui = opened.screen;
  expect(opened.state.pendingRecovery?.reason).toBe('dependency-blocked');
  return opened;
}

it('warns before the last skip and shows the ended run without opening review', async () => {
  const { screen, ref, runWorkflow } = await openDependencyBlockedRun();
  expect
    .soft(stripAnsiStyles(screen.lastFrame()))
    .toMatch(/Skip brief +ends the run, nothing was built/u);

  screen.stdin.write('s');
  await vi.waitFor(() => {
    expect(loadState(ref)?.closed).toMatchObject({ as: 'ended' });
    const frame = stripAnsiStyles(screen.lastFrame());
    expect(frame).toContain('Ended');
    expect(frame).toContain(
      'All briefs were skipped, so nothing was built. The run ended without changes.',
    );
  });
  expect(runWorkflow).not.toHaveBeenCalled();
});

it('gives back the whole /steer line with its reason on a halt that takes no typed correction', async () => {
  const { screen, ref, state, runWorkflow } = await openDependencyBlockedRun();

  screen.stdin.write('/steer use the old name');
  await flushEffects();
  screen.stdin.write('\r');
  await vi.waitFor(() => {
    expect(composerLiveStore.get().text).toBe('/steer use the old name');
    expect(feedbackStore.get()).toEqual({ message: NO_CORRECTION, severity: 'warning' });
  });
  await flushEffects();
  const frame = stripAnsiStyles(screen.lastFrame());
  expect(frame).toContain(NO_CORRECTION);
  const refusalRow = frame.split('\n').find((line) => line.includes(NO_CORRECTION)) ?? '';
  expect(refusalRow).not.toContain(glyph('statusFailed'));
  expect(frame).toContain(`${glyph('prompt')} /steer use the old name`);
  expect(completionStore.get().open).toBe(false);
  expect(frame).toContain('Needs you');
  expect(runWorkflow).not.toHaveBeenCalled();
  expect(loadState(ref)?.pendingRecovery?.id).toBe(state.pendingRecovery?.id);
});

const REFUSED_WORDS = 'use the old name';

// The halt refuses the words, puts them back and asks again. The keys stay with the words, so the
// next letter goes to the draft and chooses no row.
it.each([
  ['after tab and the typed words', undefined],
  ['when the halt opens over the saved words', REFUSED_WORDS],
])('leaves the keys with plain words that the halt refuses, %s', async (_entry, draft) => {
  const { screen, runWorkflow } = await openDependencyBlockedRun(draft);
  if (draft === undefined) {
    screen.stdin.write('\t');
    await flushEffects();
    screen.stdin.write(REFUSED_WORDS);
    await vi.waitFor(() => expect(composerLiveStore.get().text).toBe(REFUSED_WORDS));
  }

  screen.stdin.write('\r');
  // The run sets the feedback and the put-back request in one step. A consumed request then means
  // that the words are back.
  await vi.waitFor(() => {
    expect(feedbackStore.get()).toEqual({ message: NO_CORRECTION, severity: 'warning' });
    expect(composerDraftStore.get().request).toBeNull();
    expect(composerLiveStore.get().text).toBe(REFUSED_WORDS);
  });
  await vi.waitFor(() =>
    expect(stripAnsiStyles(screen.lastFrame())).toContain(
      'typing goes to the composer · tab back to the actions',
    ),
  );
  await flushEffects();

  screen.stdin.write('s');
  await vi.waitFor(() => expect(composerLiveStore.get().text).toBe(`${REFUSED_WORDS}s`));
  expect(runWorkflow).not.toHaveBeenCalled();
});
