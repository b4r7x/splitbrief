import { describe, it, expect } from 'vitest';
import { suggestRuntimeCommand } from './lookup.js';
import type { RuntimeCommandDef } from './types.js';

const COMMANDS: RuntimeCommandDef[] = [
  { kind: 'noarg', name: '/help', label: 'Help', description: '', validScreens: ['home'], handler: () => {} },
  { kind: 'arg', name: '/mode', label: 'Mode', description: '', validScreens: ['home'], handler: () => {} },
  { kind: 'noarg', name: '/settings', label: 'Settings', description: '', validScreens: ['home'], handler: () => {} },
  { kind: 'noarg', name: '/planner', label: 'Planner', description: '', validScreens: ['home'], handler: () => {} },
  { kind: 'noarg', name: '/quit', label: 'Quit', description: '', validScreens: ['home'], handler: () => {} },
];

describe('suggestRuntimeCommand', () => {
  it('returns null for empty query', () => {
    expect(suggestRuntimeCommand(COMMANDS, '')).toBeNull();
    expect(suggestRuntimeCommand(COMMANDS, '/')).toBeNull();
  });

  it('/mde resolves to /mode (dropped letter)', () => {
    expect(suggestRuntimeCommand(COMMANDS, '/mde')?.name).toBe('/mode');
  });

  it('/settngs resolves to /settings', () => {
    expect(suggestRuntimeCommand(COMMANDS, '/settngs')?.name).toBe('/settings');
  });

  it('/hlp resolves to /help', () => {
    expect(suggestRuntimeCommand(COMMANDS, '/hlp')?.name).toBe('/help');
  });

  it('returns null when the query has no resemblance to any command', () => {
    expect(suggestRuntimeCommand(COMMANDS, '/zzzzzzzzz')).toBeNull();
  });

  it('matches without a leading slash', () => {
    expect(suggestRuntimeCommand(COMMANDS, 'hlp')?.name).toBe('/help');
  });
});
