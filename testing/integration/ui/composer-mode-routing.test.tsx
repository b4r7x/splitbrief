import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Box } from 'ink';
import type { ComponentProps } from 'react';
import { flushEffects, renderFeature, tick } from '#testing/helpers/ink.js';
import { resetAllStores } from '#testing/helpers/stores.js';
import { terminalSizeStore } from '../../../src/stores/ui/terminal-size.js';
import type { RuntimeCommandDef } from '../../../src/core/runtime/commands/types.js';
import { Composer } from '../../../src/components/composer/composer.js';
import { COMMANDS, renderDockedComposer } from '#testing/helpers/composer.js';

const ENTER = '\r';
const CTRL_B = '\x02';
const CTRL_E = '\x05';

describe('composer mode routing', () => {
  beforeEach(() => {
    resetAllStores();
  });

  it('routes Ctrl+E to the review edit shortcut only in review mode', async () => {
    const edit = vi.fn();
    const submits: string[] = [];
    const ui = renderDockedComposer({
      commands: COMMANDS,
      currentScreen: 'workflow',
      mode: 'review',
      hint: 'approve | Ctrl+E/e edit',
      onSubmit: (text) => submits.push(text),
      onRuntimeCommand: () => {},
      onEditShortcut: edit,
    });
    await flushEffects();

    ui.stdin.write(CTRL_E);
    await flushEffects();

    expect(edit).toHaveBeenCalledTimes(1);
    expect(submits).toEqual([]);

    ui.unmount();
  });

  it('keeps Ctrl+E as text editing in normal mode even when an edit shortcut callback exists', async () => {
    const edit = vi.fn();
    const submits: string[] = [];
    const ui = renderDockedComposer({
      commands: COMMANDS,
      currentScreen: 'workflow',
      mode: 'normal',
      hint: '',
      onSubmit: (text) => submits.push(text),
      onRuntimeCommand: () => {},
      onEditShortcut: edit,
    });

    await flushEffects();
    ui.stdin.write('ab');
    await flushEffects();
    ui.stdin.write(CTRL_B);
    await flushEffects();
    ui.stdin.write(CTRL_E);
    await flushEffects();
    ui.stdin.write('!');
    await flushEffects();
    ui.stdin.write(ENTER);
    await flushEffects();

    expect(edit).not.toHaveBeenCalled();
    expect(submits).toEqual(['ab!']);

    ui.unmount();
  });

  it('routes slash-prefixed question answers to the prompt instead of runtime commands', async () => {
    const submits: string[] = [];
    const commandCalls: string[] = [];
    const commands: RuntimeCommandDef[] = [
      {
        kind: 'noarg',
        name: '/tmp/path',
        label: 'Tmp path',
        description: 'Test path-shaped command',
        validScreens: ['workflow'],
        handler: () => {},
      },
    ];
    const ui = renderDockedComposer({
      commands,
      currentScreen: 'workflow',
      mode: 'question',
      hint: 'Question 1/1: path?',
      onSubmit: (text) => submits.push(text),
      onRuntimeCommand: (command) => commandCalls.push(command),
    });

    await flushEffects();
    ui.stdin.write('/tmp/path');
    await flushEffects();
    ui.stdin.write(ENTER);
    await flushEffects();

    expect(submits).toEqual(['/tmp/path']);
    expect(commandCalls).toEqual([]);

    ui.unmount();
  });

  it('routes an empty question answer so continuation can use its default retry path', async () => {
    const submits: string[] = [];
    const emptySubmits: string[] = [];
    const ui = renderDockedComposer({
      commands: COMMANDS,
      currentScreen: 'workflow',
      mode: 'question',
      hint: 'Task interrupted. Enter instructions to continue (or press Enter to retry):',
      onSubmit: (text) => submits.push(text),
      onRuntimeCommand: () => {},
      onEmptySubmit: () => emptySubmits.push('empty'),
    });
    await flushEffects();

    ui.stdin.write(ENTER);
    await flushEffects();

    expect(submits).toEqual(['']);
    expect(emptySubmits).toEqual([]);

    ui.unmount();
  });

  it('routes whitespace-only question answers so recovery prompts can pause', async () => {
    const submits: string[] = [];
    const emptySubmits: string[] = [];
    const ui = renderDockedComposer({
      commands: COMMANDS,
      currentScreen: 'workflow',
      mode: 'question',
      hint: 'Recovery needed',
      onSubmit: (text) => submits.push(text),
      onRuntimeCommand: () => {},
      onEmptySubmit: () => emptySubmits.push('empty'),
    });

    await flushEffects();
    ui.stdin.write('   ');
    await flushEffects();
    ui.stdin.write(ENTER);
    await flushEffects();

    expect(submits).toEqual(['   ']);
    expect(emptySubmits).toEqual([]);

    ui.unmount();
  });

  it('clears a stale draft when questionEpoch advances in question mode', async () => {
    const submits: string[] = [];
    const ui = renderDockedComposer({
      commands: COMMANDS,
      currentScreen: 'workflow',
      mode: 'question',
      hint: 'first question',
      questionEpoch: 1,
      onSubmit: (text) => submits.push(text),
      onRuntimeCommand: () => {},
    });
    await flushEffects();
    ui.stdin.write('stale answer');
    await flushEffects();
    expect(ui.lastFrame()).toContain('stale answer');

    ui.rerender(
      <Box flexDirection="column" height={20} justifyContent="flex-end">
        <Composer
          commands={COMMANDS}
          currentScreen="workflow"
          mode="question"
          hint="second question"
          questionEpoch={2}
          onSubmit={(text) => submits.push(text)}
          onRuntimeCommand={() => {}}
        />
      </Box>,
    );
    await flushEffects();
    expect(ui.lastFrame()).not.toContain('stale answer');

    await flushEffects();
    ui.stdin.write(ENTER);
    await flushEffects();
    expect(submits).not.toContain('stale answer');
    ui.unmount();
  });
});

describe('Composer question-mode transition', () => {
  beforeEach(() => {
    resetAllStores();
    terminalSizeStore.__testReset({ cols: 80, rows: 24, isSmall: false });
  });

  afterEach(() => {
    resetAllStores();
  });

  it('does not submit stale normal-mode text after switching into question mode', async () => {
    const submits: string[] = [];
    const baseProps: Omit<ComponentProps<typeof Composer>, 'mode'> = {
      commands: [],
      currentScreen: 'workflow',
      hint: '',
      onSubmit: (text) => submits.push(text),
      onRuntimeCommand: () => {},
    };

    const ui = renderFeature(<Composer {...baseProps} mode="normal" />);
    await flushEffects();
    ui.stdin.write('stale normal text');
    await tick(20);
    expect(ui.lastFrame()).toContain('stale normal text');

    ui.rerender(<Composer {...baseProps} mode="question" />);
    await tick(20);
    expect(ui.lastFrame()).not.toContain('stale normal text');

    await flushEffects();
    ui.stdin.write('\r');
    await tick(20);

    expect(submits).not.toContain('stale normal text');
    ui.unmount();
  });
});
