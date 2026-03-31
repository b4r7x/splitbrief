import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createCommands, findCommand, toPaletteItems, executeSlashCommand } from '../src/commands.js';
import type { SlashCommandDef, CommandContext } from '../src/types.js';

const noop = () => {};

function makeCtx(): CommandContext {
  return {
    openOverlay: noop,
    closeOverlay: noop,
    showStatus: noop,
    quit: noop,
  };
}

describe('findCommand', () => {
  const commands = createCommands(makeCtx());

  it('finds command by exact name', () => {
    const cmd = findCommand(commands, '/help');
    assert.ok(cmd);
    assert.equal(cmd.name, '/help');
  });

  it('finds command case-insensitively', () => {
    const cmd = findCommand(commands, '/HELP');
    assert.ok(cmd);
    assert.equal(cmd.name, '/help');
  });

  it('returns undefined for unknown command', () => {
    const cmd = findCommand(commands, '/unknown');
    assert.equal(cmd, undefined);
  });
});

describe('toPaletteItems', () => {
  const commands = createCommands(makeCtx());

  it('converts commands with labels to palette items', () => {
    const items = toPaletteItems(commands);
    assert.ok(items.length > 0);
    for (const item of items) {
      assert.ok(item.label);
      assert.ok(item.description);
      assert.ok(typeof item.action === 'function');
      assert.ok(Array.isArray(item.availableOn));
    }
  });

  it('excludes commands without labels', () => {
    const cmds: SlashCommandDef[] = [
      { name: '/no-label', description: 'test', validScreens: ['home'], handler: noop },
      { name: '/with-label', label: 'Labeled', description: 'test', validScreens: ['home'], handler: noop },
    ];
    const items = toPaletteItems(cmds);
    assert.equal(items.length, 1);
    assert.equal(items[0].label, 'Labeled');
  });
});

describe('executeSlashCommand', () => {
  it('calls handler for valid command on valid screen', () => {
    let called = false;
    const cmds: SlashCommandDef[] = [
      { name: '/test', description: 'test', validScreens: ['home'], handler: () => { called = true; } },
    ];
    executeSlashCommand(cmds, '/test', 'home', noop);
    assert.ok(called);
  });

  it('calls onError for unknown command', () => {
    let errorMsg = '';
    executeSlashCommand([], '/nope', 'home', (msg) => { errorMsg = msg; });
    assert.ok(errorMsg.includes('Unknown command'));
  });

  it('calls onError when command not valid for screen', () => {
    let errorMsg = '';
    const cmds: SlashCommandDef[] = [
      { name: '/init', description: 'test', validScreens: ['home'], handler: noop },
    ];
    executeSlashCommand(cmds, '/init', 'workflow', (msg) => { errorMsg = msg; });
    assert.ok(errorMsg.includes('only available'));
  });
});
