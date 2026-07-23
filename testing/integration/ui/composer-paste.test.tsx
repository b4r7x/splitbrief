import { beforeEach, describe, expect, it } from 'vitest';
import { flushEffects } from '#testing/helpers/ink.js';
import { resetAllStores } from '#testing/helpers/stores.js';
import { COMMANDS, renderDockedComposer } from '#testing/helpers/composer.js';

const ENTER = '\r';

describe('composer paste capture', () => {
  beforeEach(() => {
    resetAllStores();
  });

  it('collapses a big multi-line paste to a dim marker instead of filling the field', async () => {
    const ui = renderDockedComposer({
      commands: COMMANDS,
      currentScreen: 'workflow',
      mode: 'normal',
      hint: '',
      onSubmit: () => {},
      onRuntimeCommand: () => {},
    });

    await flushEffects();
    ui.stdin.write('line 1\nline 2\nline 3\nline 4\nline 5');
    await flushEffects();

    const frame = ui.lastFrame() ?? '';
    expect(frame).toContain('[paste #1 +5 lines]');
    expect(frame).not.toContain('line 5');

    ui.unmount();
  });

  it('submits the typed text with the captured paste body appended', async () => {
    const submits: string[] = [];
    const ui = renderDockedComposer({
      commands: COMMANDS,
      currentScreen: 'workflow',
      mode: 'normal',
      hint: '',
      onSubmit: (text) => submits.push(text),
      onRuntimeCommand: () => {},
    });

    await flushEffects();
    ui.stdin.write('alpha\nbeta\ngamma\ndelta');
    await flushEffects();
    ui.stdin.write('fix the log');
    await flushEffects();
    ui.stdin.write(ENTER);
    await flushEffects();

    expect(submits).toEqual(['fix the log\n\nalpha\nbeta\ngamma\ndelta']);
    ui.unmount();
  });
});
