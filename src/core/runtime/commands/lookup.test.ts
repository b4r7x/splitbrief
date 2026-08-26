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
    aliases: [{ name: '/config' }],
    category: 'navigate',
    validScreens: ['home'],
    handler: () => {},
  },
  {
    kind: 'noarg',
    name: '/crew',
    label: 'Crew',
    description: '',
    aliases: [{ name: '/planner', args: 'plan' }],
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
    expect(findRuntimeCommand(COMMANDS, '/settings')?.command.name).toBe('/settings');
  });

  it('resolves an alias to its command and carries the arguments the alias names', () => {
    const match = findRuntimeCommand(COMMANDS, '/planner');
    expect(match?.command.name).toBe('/crew');
    expect(match?.aliasArgs).toBe('plan');
  });

  it('leaves the arguments empty for an alias that names none', () => {
    const match = findRuntimeCommand(COMMANDS, '/config');
    expect(match?.command.name).toBe('/settings');
    expect(match?.aliasArgs).toBeUndefined();
  });

  it('returns null for a name no command answers to', () => {
    expect(findRuntimeCommand(COMMANDS, '/effort')).toBeNull();
  });
});

describe('suggestRuntimeCommand', () => {
  it.each([
    { description: 'returns null for empty query', input: '', expected: null },
    { description: 'returns null for empty query', input: '/', expected: null },
  ])('$description', ({ input, expected }) => {
    expect(suggestRuntimeCommand(COMMANDS, input)).toBe(expected);
  });

  it('returns null when the query has no resemblance to any command', () => {
    expect(suggestRuntimeCommand(COMMANDS, '/zzzzzzzzz')).toBeNull();
  });

  it('matches without a leading slash', () => {
    expect(suggestRuntimeCommand(COMMANDS, 'hlp')?.name).toBe('/help');
  });
});
