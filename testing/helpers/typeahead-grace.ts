import { vi } from 'vitest';
import { PROMPT_TYPEAHEAD_GRACE_MS } from '../../src/lib/terminal/typeahead-grace.js';
import { stripAnsiStyles } from './ansi.js';
import { flushEffects } from './ink.js';

/**
 * Waits until the frame shows `shown`, then moves a fake `Date` past the typeahead grace. A prompt
 * starts its grace when it is drawn or opened, later than a wait begun before it; the clock starts
 * at the frame, so it passes the grace however late the prompt was drawn. `Date` stays fake after
 * it: the test file puts the real clock back after each test.
 */
export async function waitPastGrace(
  ui: { lastFrame: () => string | undefined },
  shown: string | RegExp,
): Promise<void> {
  await vi.waitFor(() => {
    const frame = stripAnsiStyles(ui.lastFrame() ?? '');
    if (typeof shown === 'string' ? frame.includes(shown) : shown.test(frame)) return;
    throw new Error(`The frame does not show ${String(shown)}.`);
  });
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.advanceTimersByTime(PROMPT_TYPEAHEAD_GRACE_MS + 30);
  await flushEffects();
}
