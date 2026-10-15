import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushEffects } from '#testing/helpers/ink.js';
import { renderThroughFilteredStdin } from '#testing/helpers/filtered-stdin-harness.js';
import { resetAllStores } from '#testing/helpers/stores.js';
import { terminalSizeStore } from '../../stores/ui/terminal-size.js';
import { Composer } from './composer.js';

let unmount: (() => void) | undefined;

beforeEach(() => {
  resetAllStores();
  terminalSizeStore.__testReset({ cols: 80, rows: 24 });
});

afterEach(() => {
  unmount?.();
  unmount = undefined;
});

describe('Composer backspace bytes that share one terminal read', () => {
  it.each([
    ['two DEL bytes', '\x7f\x7f', 'abcd'],
    ['three DEL bytes', '\x7f\x7f\x7f', 'abc'],
    ['three BS bytes', '\b\b\b', 'abc'],
    ['DEL then BS', '\x7f\b', 'abcd'],
    ['DEL bytes mixed with text', '\x7f\x7fXY\x7f', 'abcdX'],
  ])('deletes one character per byte for %s', async (_label, chunk, expected) => {
    const onSubmit = vi.fn();
    const ui = renderThroughFilteredStdin(
      <Composer
        commands={[]}
        currentScreen="home"
        mode="normal"
        hint=""
        onSubmit={(submission) => onSubmit(submission.message.text)}
        onRuntimeCommand={() => {}}
      />,
    );
    unmount = ui.unmount;
    await flushEffects();
    ui.pressBytes('abcdef');
    await flushEffects();
    ui.pressBytes(chunk);
    await flushEffects();
    ui.pressBytes('\r');
    await flushEffects();
    expect(onSubmit).toHaveBeenCalledExactlyOnceWith(expected);
  });
});
