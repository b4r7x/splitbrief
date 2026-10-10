import { describe, it, expect } from 'vitest';
import {
  findRuntimeCommand,
  isRuntimeCommandLine,
  rankClosedOptions,
  suggestRuntimeCommand,
} from './lookup.js';
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

describe('rankClosedOptions', () => {
  const options = ['quick', 'standard', 'audit'];
  const descriptions = {
    quick: 'one planner call, no gates',
    standard: 'ordinary feature work',
    audit: 'large, risky work that needs a security review',
  };

  it('returns every option in input order for the empty query', () => {
    expect(rankClosedOptions(options, descriptions, '')).toEqual(options);
  });

  it('matches description text', () => {
    expect(rankClosedOptions(options, descriptions, 'sec')).toEqual(['audit']);
  });

  it('drops options the query does not match', () => {
    expect(rankClosedOptions(options, undefined, 'quic')).toEqual(['quick']);
  });
});

describe('isRuntimeCommandLine', () => {
  it.each(['/', '/help', '/crew plan', '/skill:review', '/nope', '/copy some/path.md'])(
    '%s is a runtime command',
    (line) => {
      expect(isRuntimeCommandLine(line)).toBe(true);
    },
  );

  it.each([
    '/Users/dev/notes/brief.md',
    '/Users/dev/Projects/app/docs',
    '/tmp/brief.md read this first',
    '/Users/dev/notes/\nplan it',
    'read /help first',
    'plan the change',
    '',
  ])('%s is text for the planner', (line) => {
    expect(isRuntimeCommandLine(line)).toBe(false);
  });
});
