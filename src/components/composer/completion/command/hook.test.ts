import { createElement } from 'react';
import { Box, Text } from 'ink';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Composer } from '../../composer.js';
import { renderFeature, flushEffects, tick } from '#testing/helpers/ink.js';
import { resetAllStores } from '#testing/helpers/stores.js';
import { inputHistoryStore } from '../../../../stores/ui/input-history.js';
import { useCommandCompletion } from './hook.js';
import type { RuntimeCommandDef } from '../../../../core/runtime/commands/types.js';

const ENTER = '\r';
const ARROW_UP = '\u001b[A';

const COMMANDS: RuntimeCommandDef[] = [
  {
    kind: 'noarg',
    name: '/help',
    label: 'Help',
    description: 'Show help',
    validScreens: ['home'],
    handler: () => {},
  },
  {
    kind: 'arg',
    name: '/copy',
    label: 'Copy',
    description: 'Copy a value',
    validScreens: ['home'],
    handler: () => {},
  },
  {
    kind: 'arg',
    name: '/queue',
    label: 'Queue',
    description: 'Manage the queue',
    validScreens: ['home'],
    handler: () => {},
  },
  {
    kind: 'noarg',
    name: '/sidebar',
    label: 'Sidebar',
    description: 'Toggle the sidebar',
    validScreens: ['home'],
    handler: () => {},
  },
];

function ShowSuggestionsHarness({ value, suppressed }: { value: string; suppressed?: boolean }) {
  const command = useCommandCompletion({
    commands: COMMANDS,
    currentScreen: 'home',
    value,
    setValue: () => {},
    onRuntimeCommand: () => {},
    suppressed,
  });
  return createElement(Text, null, String(command.showSuggestions));
}

function renderComposer() {
  const commandCalls: string[] = [];
  const submits: string[] = [];
  const ui = renderFeature(
    createElement(
      Box,
      { flexDirection: 'column', height: 12, justifyContent: 'flex-end' },
      createElement(Composer, {
        commands: COMMANDS,
        currentScreen: 'home',
        mode: 'normal',
        hint: '',
        onSubmit: (text: string) => submits.push(text),
        onRuntimeCommand: (command: string) => commandCalls.push(command),
      }),
    ),
  );
  return { ui, commandCalls, submits };
}

describe('useCommandCompletion submit routing', () => {
  beforeEach(() => {
    resetAllStores();
  });

  it('sends an unmatched slash command to the dispatcher on Enter', async () => {
    const { ui, commandCalls, submits } = renderComposer();

    ui.stdin.write('/nope');
    await tick(20);
    await vi.waitFor(
      () => {
        expect(ui.lastFrame()).toContain('/nope');
      },
      { timeout: 5000 },
    );
    await flushEffects();
    ui.stdin.write(ENTER);
    await vi.waitFor(
      () => {
        expect(commandCalls).toEqual(['/nope']);
      },
      { timeout: 5000 },
    );

    expect(submits).toEqual([]);
    ui.unmount();
  });

  it('forwards an argument-bearing command unchanged on Enter', async () => {
    const { ui, commandCalls, submits } = renderComposer();

    ui.stdin.write('/copy path');
    await tick(20);
    await vi.waitFor(
      () => {
        expect(ui.lastFrame()).toContain('/copy path');
      },
      { timeout: 5000 },
    );
    await flushEffects();
    ui.stdin.write(ENTER);
    await vi.waitFor(
      () => {
        expect(commandCalls).toEqual(['/copy path']);
      },
      { timeout: 5000 },
    );

    expect(submits).toEqual([]);
    ui.unmount();
  });

  it('forwards /queue clear unchanged on Enter', async () => {
    const { ui, commandCalls } = renderComposer();

    ui.stdin.write('/queue clear');
    await tick(20);
    await vi.waitFor(
      () => {
        expect(ui.lastFrame()).toContain('/queue clear');
      },
      { timeout: 5000 },
    );
    await flushEffects();
    ui.stdin.write(ENTER);
    await vi.waitFor(
      () => {
        expect(commandCalls).toEqual(['/queue clear']);
      },
      { timeout: 5000 },
    );
    ui.unmount();
  });

  it('runs the highlighted command when one matches the token', async () => {
    const { ui, commandCalls } = renderComposer();

    ui.stdin.write('/cop');
    await tick(20);
    await vi.waitFor(
      () => {
        expect(ui.lastFrame()).toContain('/cop');
      },
      { timeout: 5000 },
    );
    await flushEffects();
    ui.stdin.write(ENTER);
    await vi.waitFor(
      () => {
        expect(commandCalls).toEqual(['/copy']);
      },
      { timeout: 5000 },
    );
    ui.unmount();
  });
});

describe('useCommandCompletion suppression', () => {
  beforeEach(() => {
    resetAllStores();
  });

  it('suppressed hides command suggestions for a bare slash value', async () => {
    const shown = renderFeature(createElement(ShowSuggestionsHarness, { value: '/help' }));
    await tick(20);
    expect(shown.lastFrame()).toContain('true');
    shown.unmount();

    const hidden = renderFeature(
      createElement(ShowSuggestionsHarness, { value: '/help', suppressed: true }),
    );
    await tick(20);
    expect(hidden.lastFrame()).toContain('false');
    hidden.unmount();
  });

  it('recalling a bare slash command keeps history stepping on up-arrow', async () => {
    inputHistoryStore.hydrate(['/sidebar', 'older-a', 'older-b']);
    const { ui } = renderComposer();

    ui.stdin.write(ARROW_UP);
    await tick(20);
    await vi.waitFor(
      () => {
        expect(ui.lastFrame()).toContain('/sidebar');
      },
      { timeout: 5000 },
    );
    expect(ui.lastFrame()).not.toContain('Toggle the sidebar');

    ui.stdin.write(ARROW_UP);
    await tick(20);
    await vi.waitFor(
      () => {
        expect(ui.lastFrame()).toContain('older-a');
      },
      { timeout: 5000 },
    );
    ui.unmount();
  });
});
