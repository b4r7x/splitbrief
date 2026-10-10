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
      onSubmit: (submission) => submits.push(submission.message.displayText),
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
      onSubmit: (submission) => submits.push(submission.message.displayText),
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
        category: 'navigate',
        validScreens: ['workflow'],
        handler: () => {},
      },
    ];
    const ui = renderDockedComposer({
      commands,
      currentScreen: 'workflow',
      mode: 'question',
      hint: 'Question 1/1: path?',
      onSubmit: (submission) => submits.push(submission.message.displayText),
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
      onSubmit: (submission) => submits.push(submission.message.displayText),
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

  it('routes whitespace-only question answers so a recovery prompt takes its recommendation', async () => {
    const submits: string[] = [];
    const emptySubmits: string[] = [];
    const ui = renderDockedComposer({
      commands: COMMANDS,
      currentScreen: 'workflow',
      mode: 'question',
      hint: 'Needs you',
      onSubmit: (submission) => submits.push(submission.message.displayText),
      onRuntimeCommand: () => {},
      onEmptySubmit: () => emptySubmits.push('empty'),
    });

    await flushEffects();
    ui.stdin.write('   ');
    await flushEffects();
    ui.stdin.write(ENTER);
    await flushEffects();

    expect(submits).toEqual(['']);
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
      onSubmit: (submission) => submits.push(submission.message.displayText),
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
          onSubmit={(submission) => submits.push(submission.message.displayText)}
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

  it('keeps an unsent normal-mode draft through a flip into question mode, submitting it only on Enter', async () => {
    const submits: string[] = [];
    const baseProps: Omit<ComponentProps<typeof Composer>, 'mode'> = {
      commands: [],
      currentScreen: 'workflow',
      hint: '',
      onSubmit: (submission) => submits.push(submission.message.displayText),
      onRuntimeCommand: () => {},
    };

    const ui = renderFeature(<Composer {...baseProps} mode="normal" />);
    await flushEffects();
    ui.stdin.write('stale normal text');
    await tick(20);
    expect(ui.lastFrame()).toContain('stale normal text');

    ui.rerender(<Composer {...baseProps} mode="question" />);
    await tick(20);
    // The flip neither clears the draft nor submits it as an answer: one unsent session draft spans
    // both modes, and only a new question (questionEpoch advance) discards text typed for the old one.
    expect(ui.lastFrame()).toContain('stale normal text');
    expect(submits).toEqual([]);

    await flushEffects();
    ui.stdin.write('\r');
    await tick(20);

    // A bare Enter submits it once, as the answer it now sits in — visibly, not silently.
    expect(submits).toEqual(['stale normal text']);
    expect(ui.lastFrame()).not.toContain('stale normal text');
    ui.unmount();
  });
});
