import { describe, expect, it } from 'vitest';
import { makeConfig } from '#testing/helpers/factories/config.js';
import type { RuntimeCommandDef } from '../../core/runtime/commands/types.js';
import { buildPaletteSources } from './sources.js';

const noop = () => {};

function buildCommandSources(commands: RuntimeCommandDef[], onRuntimeCommand: (raw: string) => void = noop) {
  return buildPaletteSources({
    commands,
    screen: 'home',
    config: makeConfig(),
    phase: 'idle',
    tasks: [],
    sessions: [],
    onRuntimeCommand,
    onWorkflowMode: noop,
  }).commandItems;
}

describe('buildPaletteSources command items', () => {
  it('converts labeled commands to palette command items', () => {
    const items = buildCommandSources([
      {
        kind: 'noarg',
        name: '/help',
        label: 'Help',
        description: 'Show help',
        shortcut: 'ctrl+/',
        validScreens: ['home'],
        handler: noop,
      },
    ]);

    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      label: 'Help',
      description: 'Show help',
      shortcut: 'ctrl+/',
      availableOn: ['home'],
    });
  });

  it('excludes unlabeled commands and commands unavailable on the current screen', () => {
    const items = buildCommandSources([
      { kind: 'noarg', name: '/no-label', description: 'Hidden', validScreens: ['home'], handler: noop },
      {
        kind: 'noarg',
        name: '/workflow-only',
        label: 'Workflow only',
        description: 'Workflow command',
        validScreens: ['workflow'],
        handler: noop,
      },
      {
        kind: 'noarg',
        name: '/visible',
        label: 'Visible',
        description: 'Visible command',
        validScreens: ['home'],
        handler: noop,
      },
    ]);

    expect(items.map(item => item.label)).toEqual(['Visible']);
  });

  it('runs command item actions through the runtime command callback', () => {
    const calls: string[] = [];
    const items = buildCommandSources([
      {
        kind: 'noarg',
        name: '/settings',
        label: 'Settings',
        description: 'Open settings',
        validScreens: ['home'],
        handler: noop,
      },
    ], raw => calls.push(raw));

    items[0]?.action();

    expect(calls).toEqual(['/settings']);
  });
});
