import { describe, it, expect } from 'vitest';
import { findRuntimeCommand, suggestRuntimeCommand } from './lookup.js';
import type { RuntimeCommandDef } from './types.js';

const COMMANDS: RuntimeCommandDef[] = [
  {
    kind: 'noarg',
    name: '/help',
    label: 'Help',
    description: '',
    category: 'navigate',
    validScreens: ['home'],
    handler: () => {},
  },
  {
    kind: 'arg',
    name: '/mode',
    label: 'Mode',
    description: '',
    category: 'crew',
    args: { kind: 'closed', options: ['instant', 'quick'], optional: true },
    validScreens: ['home'],
    handler: () => {},
  },
  {
    kind: 'noarg',
    name: '/settings',
    label: 'Settings',
    description: '',
    category: 'navigate',
    validScreens: ['home'],
    handler: () => {},
  },
  {
    kind: 'noarg',
    name: '/crew',
    label: 'Crew',
    description: '',
    category: 'crew',
    validScreens: ['home'],
    handler: () => {},
  },
  {
    kind: 'noarg',
    name: '/quit',
    label: 'Quit',
    description: '',
    category: 'navigate',
    validScreens: ['home'],
    handler: () => {},
  },
];

describe('findRuntimeCommand', () => {
  it('resolves a command by its own name', () => {
    expect(findRuntimeCommand(COMMANDS, '/settings')?.name).toBe('/settings');
  });

  it('resolves a command typed in another case', () => {
    expect(findRuntimeCommand(COMMANDS, '/Crew')?.name).toBe('/crew');
  });

  it('returns null for a name no command answers to', () => {
    expect(findRuntimeCommand(COMMANDS, '/effort')).toBeNull();
  });
});

describe('suggestRuntimeCommand', () => {
  it.each(['', '/'])('returns null for the empty query %j', (input) => {
    expect(suggestRuntimeCommand(COMMANDS, input)).toBeNull();
  });

  it('returns null when the query has no resemblance to any command', () => {
    expect(suggestRuntimeCommand(COMMANDS, '/zzzzzzzzz')).toBeNull();
  });

  it('matches without a leading slash', () => {
    expect(suggestRuntimeCommand(COMMANDS, 'hlp')?.name).toBe('/help');
  });
});
