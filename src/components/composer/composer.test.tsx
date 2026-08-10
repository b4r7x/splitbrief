import { beforeEach, describe, expect, it } from 'vitest';
import { flushEffects, renderFeature } from '#testing/helpers/ink.js';
import { resetAllStores } from '#testing/helpers/stores.js';
import type { RuntimeCommandDef } from '../../core/runtime/commands/types.js';
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
    await flushEffects();
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

    await flushEffects();
    ui.stdin.write('\r');
    await flushEffects();
    expect(submissions).not.toContain('unfinished answer');
    ui.unmount();
  });
});

describe('Composer submit draft retention', () => {
  const COMMANDS: RuntimeCommandDef[] = [
    {
      kind: 'arg',
      name: '/mode',
      label: 'Mode',
      description: 'Workflow mode',
      validScreens: ['home'],
      handler: () => {},
    },
  ];

  beforeEach(() => {
    resetAllStores();
    terminalSizeStore.__testReset({ cols: 80, rows: 24 });
  });

  it('clears the submitted draft by default', async () => {
    const submissions: string[] = [];
    const ui = renderFeature(
      <Composer
        commands={[]}
        currentScreen="home"
        mode="normal"
        hint=""
        onSubmit={(text) => submissions.push(text)}
        onRuntimeCommand={() => {}}
      />,
    );
    await flushEffects();
    ui.stdin.write('cleared feature');
    await flushEffects();
    ui.stdin.write('\r');
    await flushEffects();

    expect(submissions).toEqual(['cleared feature']);
    expect(ui.lastFrame()).not.toContain('cleared feature');
    ui.unmount();
  });

  it('keeps the submitted draft when submitKeepsDraft is set', async () => {
    const submissions: string[] = [];
    const ui = renderFeature(
      <Composer
        commands={[]}
        currentScreen="home"
        mode="normal"
        hint=""
        submitKeepsDraft
        onSubmit={(text) => submissions.push(text)}
        onRuntimeCommand={() => {}}
      />,
    );
    await flushEffects();
    ui.stdin.write('kept feature');
    await flushEffects();
    ui.stdin.write('\r');
    await flushEffects();

    expect(submissions).toEqual(['kept feature']);
    expect(ui.lastFrame()).toContain('kept feature');
    ui.unmount();
  });

  it('still clears a runtime command when submitKeepsDraft is set', async () => {
    const dispatched: string[] = [];
    const ui = renderFeature(
      <Composer
        commands={COMMANDS}
        currentScreen="home"
        mode="normal"
        hint=""
        submitKeepsDraft
        onSubmit={() => {}}
        onRuntimeCommand={(command) => dispatched.push(command)}
      />,
    );
    await flushEffects();
    ui.stdin.write('/mode quick');
    await flushEffects();
    ui.stdin.write('\r');
    await flushEffects();

    expect(dispatched).toEqual(['/mode quick']);
    expect(ui.lastFrame()).not.toContain('/mode quick');
    ui.unmount();
  });

  it('renders the supplied prompt glyph in place of the default marker', async () => {
    const ui = renderFeature(
      <Composer
        commands={[]}
        currentScreen="home"
        mode="normal"
        hint=""
        promptGlyph="⠋"
        onSubmit={() => {}}
        onRuntimeCommand={() => {}}
      />,
    );
    await flushEffects();

    expect(ui.lastFrame()).toContain('⠋');
    ui.unmount();
  });
});
