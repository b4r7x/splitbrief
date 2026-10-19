import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { flushEffects } from '#testing/helpers/ink.js';
import { renderThroughFilteredStdin } from '#testing/helpers/filtered-stdin-harness.js';
import { resetAllStores } from '#testing/helpers/stores.js';
import { editorStore } from '../../stores/ui/editor.js';
import { overlayStore } from '../../stores/ui/overlay.js';
import { terminalSizeStore } from '../../stores/ui/terminal-size.js';
import { EditorOverlay } from './editor.js';

const END = '\x1b[F';
const LEFT = '\x1b[D';

let unmount: (() => void) | undefined;

beforeEach(() => {
  resetAllStores();
  terminalSizeStore.__testReset({ cols: 80, rows: 24 });
});

afterEach(() => {
  unmount?.();
  unmount = undefined;
});

describe('Editor overlay backspace through the terminal input filter', () => {
  it.each([
    ['Backspace deletes the character before the caret', 'AB', [END, LEFT, '\x7f'], 'B'],
    [
      'legacy Alt+Backspace deletes the word before the caret',
      'foo bar',
      [END, '\x1b\x7f'],
      'foo ',
    ],
    [
      'kitty Alt+Backspace deletes the word before the caret',
      'foo bar',
      [END, '\x1b[127;3u'],
      'foo ',
    ],
    ['Delete deletes the character after the caret', 'AB', [END, LEFT, '\x1b[3~'], 'A'],
  ])('%s', async (_label, value, keys, expected) => {
    editorStore.openRaw({
      filePath: '/tmp/plan.json',
      value,
      ownerToken: 0,
      layout: { columns: 80, rows: 24 },
    });
    overlayStore.open('editor');
    const ui = renderThroughFilteredStdin(<EditorOverlay />, { cols: 80, rows: 24 });
    unmount = ui.unmount;
    await flushEffects();
    for (const key of keys) {
      ui.pressBytes(key);
      await flushEffects();
    }
    expect(editorStore.get()).toMatchObject({ value: expected });
  });
});
