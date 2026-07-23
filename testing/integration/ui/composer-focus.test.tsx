import { beforeEach, describe, expect, it } from 'vitest';
import { flushEffects } from '#testing/helpers/ink.js';
import { resetAllStores } from '#testing/helpers/stores.js';
import { focusStore } from '../../../src/stores/ui/focus.js';
import { COMMANDS, renderDockedComposer } from '#testing/helpers/composer.js';

describe('composer row-focus hand-off', () => {
  beforeEach(() => {
    resetAllStores();
  });

  it('types into the field when no row focus is held', async () => {
    const ui = renderDockedComposer({
      commands: COMMANDS,
      currentScreen: 'workflow',
      mode: 'normal',
      hint: '',
      onSubmit: () => {},
      onRuntimeCommand: () => {},
    });
    await flushEffects();

    ui.stdin.write('hello');
    await flushEffects();

    expect(ui.lastFrame()).toContain('hello');
    ui.unmount();
  });

  it('yields the text field while a workflow row focus is held', async () => {
    focusStore.set('brief', 0);

    const ui = renderDockedComposer({
      commands: COMMANDS,
      currentScreen: 'workflow',
      mode: 'normal',
      hint: '',
      onSubmit: () => {},
      onRuntimeCommand: () => {},
    });
    await flushEffects();

    ui.stdin.write('hello');
    await flushEffects();

    expect(ui.lastFrame()).not.toContain('hello');
    ui.unmount();
  });
});
