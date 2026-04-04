import { describe, it, expect } from 'vitest';
import { createCommands, findCommand, toPaletteItems, executeSlashCommand } from './commands.js';
import type { SlashCommandDef, CommandContext } from './types.js';

const noop = () => {};

function makeCtx(): CommandContext {
  return {
    openOverlay: noop,
    closeOverlay: noop,
    quit: noop,
  };
}

describe('findCommand', () => {
  const commands = createCommands(makeCtx());

  it('finds command by exact name', () => {
    const cmd = findCommand(commands, '/help');
    expect(cmd).toBeTruthy();
    expect(cmd!.name).toBe('/help');
  });

  it('finds command case-insensitively', () => {
    const cmd = findCommand(commands, '/HELP');
    expect(cmd).toBeTruthy();
    expect(cmd!.name).toBe('/help');
  });

  it('returns undefined for unknown command', () => {
    const cmd = findCommand(commands, '/unknown');
    expect(cmd).toBe(undefined);
  });
});

describe('toPaletteItems', () => {
  const commands = createCommands(makeCtx());

  it('converts commands with labels to palette items', () => {
    const items = toPaletteItems(commands);
    expect(items.length).toBeGreaterThan(0);
    for (const item of items) {
      expect(item.label).toBeTruthy();
      expect(item.description).toBeTruthy();
      expect(typeof item.action).toBe('function');
      expect(Array.isArray(item.availableOn)).toBeTruthy();
    }
  });

  it('excludes commands without labels', () => {
    const cmds: SlashCommandDef[] = [
      { name: '/no-label', description: 'test', validScreens: ['home'], handler: noop },
      { name: '/with-label', label: 'Labeled', description: 'test', validScreens: ['home'], handler: noop },
    ];
    const items = toPaletteItems(cmds);
    expect(items.length).toBe(1);
    expect(items[0].label).toBe('Labeled');
  });
});

describe('executeSlashCommand', () => {
  it('calls handler for valid command on valid screen', () => {
    let called = false;
    const cmds: SlashCommandDef[] = [
      { name: '/test', description: 'test', validScreens: ['home'], handler: () => { called = true; } },
    ];
    executeSlashCommand(cmds, '/test', 'home', noop);
    expect(called).toBeTruthy();
  });

  it('calls onError for unknown command', () => {
    let errorMsg = '';
    executeSlashCommand([], '/nope', 'home', (msg) => { errorMsg = msg; });
    expect(errorMsg).toContain('Unknown command');
  });

  it('calls onError when command not valid for screen', () => {
    let errorMsg = '';
    const cmds: SlashCommandDef[] = [
      { name: '/test-home-only', description: 'test', validScreens: ['home'], handler: noop },
    ];
    executeSlashCommand(cmds, '/test-home-only', 'workflow', (msg) => { errorMsg = msg; });
    expect(errorMsg).toContain('only available');
  });
});
