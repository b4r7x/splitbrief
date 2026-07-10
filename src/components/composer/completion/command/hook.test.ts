import { createElement } from 'react';
import { Box } from 'ink';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Composer } from '../../composer.js';
import { renderFeature, tick } from '#testing/helpers/ink.js';
import { resetAllStores } from '#testing/helpers/stores.js';
import type { RuntimeCommandDef } from '../../../../core/runtime/commands/types.js';

const ENTER = '\r';

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
];

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
    await vi.waitFor(() => {
      expect(ui.lastFrame()).toContain('/nope');
    });
    ui.stdin.write(ENTER);
    await tick(20);
    await vi.waitFor(() => {
      expect(commandCalls).toEqual(['/nope']);
    });

    expect(submits).toEqual([]);
    ui.unmount();
  });

  it('forwards an argument-bearing command unchanged on Enter', async () => {
    const { ui, commandCalls, submits } = renderComposer();

    ui.stdin.write('/copy path');
    await tick(20);
    await vi.waitFor(() => {
      expect(ui.lastFrame()).toContain('/copy path');
    });
    ui.stdin.write(ENTER);
    await tick(20);
    await vi.waitFor(() => {
      expect(commandCalls).toEqual(['/copy path']);
    });

    expect(submits).toEqual([]);
    ui.unmount();
  });

  it('forwards /queue clear unchanged on Enter', async () => {
    const { ui, commandCalls } = renderComposer();

    ui.stdin.write('/queue clear');
    await tick(20);
    await vi.waitFor(() => {
      expect(ui.lastFrame()).toContain('/queue clear');
    });
    ui.stdin.write(ENTER);
    await tick(20);
    await vi.waitFor(() => {
      expect(commandCalls).toEqual(['/queue clear']);
    });
    ui.unmount();
  });

  it('runs the highlighted command when one matches the token', async () => {
    const { ui, commandCalls } = renderComposer();

    ui.stdin.write('/cop');
    await tick(20);
    await vi.waitFor(() => {
      expect(ui.lastFrame()).toContain('/cop');
    });
    ui.stdin.write(ENTER);
    await tick(20);
    await vi.waitFor(() => {
      expect(commandCalls).toEqual(['/copy']);
    });
    ui.unmount();
  });
});
