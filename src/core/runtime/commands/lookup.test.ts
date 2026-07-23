import { describe, it, expect } from 'vitest';
import { suggestRuntimeCommand } from './lookup.js';
import type { RuntimeCommandDef } from './types.js';

const COMMANDS: RuntimeCommandDef[] = [
  {
    kind: 'noarg',
    name: '/help',
    label: 'Help',
    description: '',
    validScreens: ['home'],
    handler: () => {},
  },
  {
    kind: 'arg',
    name: '/mode',
    label: 'Mode',
    description: '',
    validScreens: ['home'],
    handler: () => {},
  },
  {
    kind: 'noarg',
    name: '/settings',
    label: 'Settings',
    description: '',
    validScreens: ['home'],
    handler: () => {},
  },
  {
    kind: 'noarg',
    name: '/planner',
    label: 'Planner',
    description: '',
    validScreens: ['home'],
    handler: () => {},
  },
  {
    kind: 'noarg',
    name: '/quit',
    label: 'Quit',
    description: '',
    validScreens: ['home'],
    handler: () => {},
  },
];

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
