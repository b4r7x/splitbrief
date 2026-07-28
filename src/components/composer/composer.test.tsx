import { beforeEach, describe, expect, it } from 'vitest';
import { flushEffects, renderFeature } from '#testing/helpers/ink.js';
import { resetAllStores } from '#testing/helpers/stores.js';
import { inputHistoryStore } from '../../stores/ui/input-history.js';
import { terminalSizeStore } from '../../stores/ui/terminal-size.js';
import { Composer } from './composer.js';

describe('Composer blocking-question isolation', () => {
  beforeEach(() => {
    resetAllStores();
    terminalSizeStore.__testReset({ cols: 80, rows: 24 });
  });

  it('never loads normal composer history into a blocking question', async () => {
    inputHistoryStore.hydrate(['NORMAL_HISTORY_SENTINEL']);
    const submissions: string[] = [];
    const ui = renderFeature(
      <Composer
        commands={[]}
        currentScreen="workflow"
        mode="question"
        hint="Blocking question"
        onSubmit={(text) => submissions.push(text)}
        onRuntimeCommand={() => {}}
      />,
    );
    await flushEffects();

    ui.stdin.write('\x1b[A');
    await flushEffects();
    ui.stdin.write('\x1b[B');
    await flushEffects();

    expect(ui.lastFrame()).not.toContain('NORMAL_HISTORY_SENTINEL');
    ui.stdin.write('\r');
    await flushEffects();
    expect(submissions).toEqual(['']);
    ui.unmount();
  });

  it('does not carry an unfinished question answer back into normal mode', async () => {
    const submissions: string[] = [];
    const composer = (mode: 'normal' | 'question') => (
      <Composer
        commands={[]}
        currentScreen="workflow"
        mode={mode}
        hint=""
        onSubmit={(text) => submissions.push(text)}
        onRuntimeCommand={() => {}}
      />
    );
    const ui = renderFeature(composer('question'));
    await flushEffects();
    ui.stdin.write('unfinished answer');
    await flushEffects();
    expect(ui.lastFrame()).toContain('unfinished answer');

    ui.rerender(composer('normal'));
    await flushEffects();
    expect(ui.lastFrame()).not.toContain('unfinished answer');

    ui.stdin.write('\r');
    await flushEffects();
    expect(submissions).not.toContain('unfinished answer');
    ui.unmount();
  });
});
