import { describe, it, expect } from 'vitest';
import { Fzf } from 'fzf';
import type { SlashCommandDef } from '../../core/slash-commands/types.js';

// Extract the pure fuzzy logic for unit testing without React hooks
function fuzzyMatchCommand(commands: SlashCommandDef[], query: string): SlashCommandDef | null {
  const bare = query.startsWith('/') ? query.slice(1) : query;
  if (!bare) return null;
  const fzf = new Fzf(commands, { selector: (c: SlashCommandDef) => c.name.slice(1) });
  const results = fzf.find(bare);
  const top = results[0];
  return top !== undefined && top.score > 0 ? top.item : null;
}

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

  it('/mde → /mode (dropped letter)', () => {
    const result = fuzzyMatchCommand(COMMANDS, '/mde');
    expect(result?.name).toBe('/mode');
  });

  it('/settngs → /settings', () => {
    const result = fuzzyMatchCommand(COMMANDS, '/settngs');
    expect(result?.name).toBe('/settings');
  });

  it('/hlp → /help', () => {
    const result = fuzzyMatchCommand(COMMANDS, '/hlp');
    expect(result?.name).toBe('/help');
  });

  it('returns null for a query with no resemblance to any command', () => {
    const result = fuzzyMatchCommand(COMMANDS, '/zzzzzzzzz');
    expect(result).toBeNull();
  });

  it('works without leading slash', () => {
    const result = fuzzyMatchCommand(COMMANDS, 'hlp');
    expect(result?.name).toBe('/help');
  });
});
