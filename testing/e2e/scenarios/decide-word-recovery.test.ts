import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadState } from '../../../src/core/state/persistence.js';
import { readRunEvents } from '../../../src/engine/events/replay.js';
import { feedbackStore } from '../../../src/stores/ui/feedback.js';
import { stripAnsiStyles } from '#testing/helpers/ansi.js';
import { flushEffects, type renderFeature } from '#testing/helpers/ink.js';
import { resetAllStores } from '#testing/helpers/stores.js';
import { cleanupTempDir } from '#testing/helpers/temp-dir.js';
import { openHaltedRun, settleOpenedRuns } from '../helpers/halted-run-screen.js';
import {
  cli,
  createStopContinueFixture,
  type StopContinueFixture,
} from '../helpers/stop-continue-fixture.js';

const QUESTION = 'Which file holds the locales?';

/** Writes nothing and reports itself blocked on the question, on every attempt. */
function blockedImplementerScript(): string {
  return `for await (const chunk of process.stdin) void chunk;
process.stdout.write(${JSON.stringify(JSON.stringify({ status: 'blocked', question: QUESTION, filesNeeded: [] }))});
`;
}

const ASK_USER = JSON.stringify({
  answer: {
    diagnosis: 'The implementer is blocked on the locale source.',
    action: 'ask-user',
    question: QUESTION,
    whyOnlyUserCanAnswer: 'Only you know which file holds the locales.',
    choices: null,
    default: null,
  },
});

/** The planner passes the implementer's question to the user with no default, so the headless run halts on it. */
function askingConsult(): string {
  return `(prompt) => {
  const heading = prompt.split('\\n').find((line) => line.startsWith('# '));
  return heading === '# Consult on a failing task' || heading === '# Consult continued'
    ? ${JSON.stringify(ASK_USER)}
    : undefined;
}`;
}

let fixture: StopContinueFixture | undefined;
let ui: ReturnType<typeof renderFeature> | undefined;

beforeEach(() => resetAllStores());

afterEach(async () => {
  ui?.unmount();
  ui = undefined;
  await settleOpenedRuns();
  resetAllStores();
  vi.unstubAllEnvs();
  if (fixture !== undefined) cleanupTempDir(fixture.tmpDir);
  fixture = undefined;
});

describe('e2e: a word typed beside a halt', () => {
  it.each(['decide', 'd', 'q', 'end', 'skip'])(
    'takes %s typed in the composer as the answer of Try again, not as an action',
    async (word) => {
      fixture = createStopContinueFixture(blockedImplementerScript, { consult: askingConsult });
      const halted = await cli(fixture, ['start', 'smoke']);
      expect(halted.exitCode, `${halted.stdout}\n${halted.stderr}`).toBe(1);
      const { screen, ref, runWorkflow } = await openHaltedRun(fixture, { heading: 'Needs you' });
      ui = screen;

      expect(stripAnsiStyles(screen.lastFrame())).toContain('Decide for me');

      screen.stdin.write('\t');
      await flushEffects();
      screen.stdin.write(word);
      await flushEffects();
      screen.stdin.write('\r');

      await vi.waitFor(() => expect(runWorkflow).toHaveBeenCalled());
      const { events } = await readRunEvents(ref);
      expect(
        events
          .filter((event) => event.type === 'recovery_action_selected')
          .map((event) => event.action),
      ).toEqual(['retry-same-worker']);
      // Only the row sets Decide for me: the typed word reaches the seat as the answer.
      expect(loadState(ref)?.decideForMe).not.toBe(true);
      expect(runWorkflow.mock.lastCall?.[0].steer?.text).toBe(word);
    },
  );

  it('runs no action on an empty Enter in the composer of a question halt', async () => {
    fixture = createStopContinueFixture(blockedImplementerScript, { consult: askingConsult });
    const halted = await cli(fixture, ['start', 'smoke']);
    expect(halted.exitCode, `${halted.stdout}\n${halted.stderr}`).toBe(1);
    const { screen, ref, runWorkflow } = await openHaltedRun(fixture, { heading: 'Needs you' });
    ui = screen;

    screen.stdin.write('\t');
    await flushEffects();
    screen.stdin.write('\r');

    await vi.waitFor(() =>
      expect(feedbackStore.get().message).toBe('Nothing to send. Tab to choose an action.'),
    );
    const { events } = await readRunEvents(ref);
    expect(events.filter((event) => event.type === 'recovery_action_selected')).toEqual([]);
    expect(runWorkflow).not.toHaveBeenCalled();
  });

  it('sets Decide for me from the row key with the menu focused, and sends no steer', async () => {
    fixture = createStopContinueFixture(blockedImplementerScript, { consult: askingConsult });
    const halted = await cli(fixture, ['start', 'smoke']);
    expect(halted.exitCode, `${halted.stdout}\n${halted.stderr}`).toBe(1);
    const { screen, ref, runWorkflow } = await openHaltedRun(fixture, { heading: 'Needs you' });
    ui = screen;

    screen.stdin.write('d');

    await vi.waitFor(() => expect(runWorkflow).toHaveBeenCalled());
    expect(loadState(ref)?.decideForMe).toBe(true);
    expect(runWorkflow.mock.lastCall?.[0].steer).toBeUndefined();
  });
});
