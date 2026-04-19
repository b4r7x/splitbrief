import { describe, it, expect } from 'vitest';
import { fuzzyMatchCommand } from './fuzzy.js';
import type { SlashCommandDef } from './types.js';

const COMMANDS: SlashCommandDef[] = [
  { kind: 'noarg', name: '/help', label: 'Help', description: '', validScreens: ['home'], handler: () => {} },
  { kind: 'arg', name: '/mode', label: 'Mode', description: '', validScreens: ['home'], handler: () => {} },
  { kind: 'noarg', name: '/settings', label: 'Settings', description: '', validScreens: ['home'], handler: () => {} },
  { kind: 'noarg', name: '/planner', label: 'Planner', description: '', validScreens: ['home'], handler: () => {} },
  { kind: 'noarg', name: '/quit', label: 'Quit', description: '', validScreens: ['home'], handler: () => {} },
];

describe('fuzzyMatchCommand', () => {
  it('returns null for empty query', () => {
    expect(fuzzyMatchCommand(COMMANDS, '')).toBeNull();
    expect(fuzzyMatchCommand(COMMANDS, '/')).toBeNull();
  });

  it('/mde resolves to /mode (dropped letter)', () => {
    expect(fuzzyMatchCommand(COMMANDS, '/mde')?.name).toBe('/mode');
  });

  it('/settngs resolves to /settings', () => {
    expect(fuzzyMatchCommand(COMMANDS, '/settngs')?.name).toBe('/settings');
  });

  it('/hlp resolves to /help', () => {
    expect(fuzzyMatchCommand(COMMANDS, '/hlp')?.name).toBe('/help');
  });

  it('returns null when the query has no resemblance to any command', () => {
    expect(fuzzyMatchCommand(COMMANDS, '/zzzzzzzzz')).toBeNull();
  });

  it('matches without a leading slash', () => {
    expect(fuzzyMatchCommand(COMMANDS, 'hlp')?.name).toBe('/help');
  });
});
