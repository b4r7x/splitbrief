import { describe, expect, it } from 'vitest';
import type { RuntimeCommandDef } from '../core/runtime/commands/types.js';
import { commandDisplayName } from './list-columns.js';

function makeCommand(
  name: string,
  aliases?: readonly { name: string; args?: string }[],
): RuntimeCommandDef {
  return {
    kind: 'noarg',
    name,
    ...(aliases ? { aliases } : {}),
    description: 'Crew, validation, workflow',
    category: 'navigate',
    validScreens: ['home'],
    handler: () => {},
  };
}

describe('commandDisplayName', () => {
  it('returns the bare name for a command without aliases', () => {
    expect(commandDisplayName(makeCommand('/settings'))).toBe('/settings');
  });

  it('inlines a bare alias next to the name', () => {
    expect(commandDisplayName(makeCommand('/settings', [{ name: '/config' }]))).toBe(
      '/settings (/config)',
    );
  });

  it('keeps an alias that carries an argument off the label', () => {
    const crew = makeCommand('/crew', [
      { name: '/planner', args: 'plan' },
      { name: '/implementer', args: 'build' },
    ]);
    expect(commandDisplayName(crew)).toBe('/crew');
  });

  it('keeps only the bare aliases when a command mixes both kinds', () => {
    const mixed = makeCommand('/settings', [
      { name: '/config' },
      { name: '/planner', args: 'plan' },
      { name: '/prefs' },
    ]);
    expect(commandDisplayName(mixed)).toBe('/settings (/config /prefs)');
  });
});
