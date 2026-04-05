import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createCommands, findCommand, toPaletteItems, executeSlashCommand } from './commands.js';
import { configStore } from '../stores/config.js';
import { feedbackStore } from '../stores/error.js';
import { makeConfig } from '#testing/helpers/fixtures.js';
import type { SlashCommandDef, CommandContext } from './types.js';

const noop = () => {};

function makeCtx(): CommandContext {
  return {
    openOverlay: noop,
    navigate: noop,
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

  it('passes args to handler', () => {
    let receivedArgs: string | undefined;
    const cmds: SlashCommandDef[] = [
      { name: '/test', description: 'test', validScreens: ['home'], handler: (args) => { receivedArgs = args; } },
    ];
    executeSlashCommand(cmds, '/test hello world', 'home', noop);
    expect(receivedArgs).toBe('hello world');
  });

  it('passes undefined args when no args given', () => {
    let receivedArgs: string | undefined = 'initial';
    const cmds: SlashCommandDef[] = [
      { name: '/test', description: 'test', validScreens: ['home'], handler: (args) => { receivedArgs = args; } },
    ];
    executeSlashCommand(cmds, '/test', 'home', noop);
    expect(receivedArgs).toBeUndefined();
  });
});

describe('/mode command', () => {
  beforeEach(() => {
    configStore.reset();
    feedbackStore.reset();
  });

  it('opens mode selector when called without args', () => {
    configStore.set({ config: makeConfig(), projectDir: '/tmp', overrides: {} });
    const openOverlay = vi.fn();
    const commands = createCommands({ ...makeCtx(), openOverlay });
    findCommand(commands, '/mode')!.handler();
    expect(openOverlay).toHaveBeenCalledWith('mode-selector');
  });

  it('sets mode to quick without opening overlay', () => {
    configStore.set({ config: makeConfig(), projectDir: '/tmp', overrides: {} });
    const openOverlay = vi.fn();
    const commands = createCommands({ ...makeCtx(), openOverlay });
    findCommand(commands, '/mode')!.handler('quick');
    expect(configStore.get().config!.workflow.mode).toBe('quick');
    expect(feedbackStore.get().message).toContain('quick');
    expect(openOverlay).not.toHaveBeenCalled();
  });

  it('sets mode to full', () => {
    configStore.set({ config: makeConfig(), projectDir: '/tmp', overrides: {} });
    const commands = createCommands(makeCtx());
    findCommand(commands, '/mode')!.handler('full');
    expect(configStore.get().config!.workflow.mode).toBe('full');
  });

  it('rejects invalid mode', () => {
    configStore.set({ config: makeConfig(), projectDir: '/tmp', overrides: {} });
    const commands = createCommands(makeCtx());
    findCommand(commands, '/mode')!.handler('turbo');
    expect(feedbackStore.get().message).toContain('Invalid mode');
  });
});

describe('/planner command', () => {
  it('has correct label and description', () => {
    const commands = createCommands(makeCtx());
    const cmd = findCommand(commands, '/planner');
    expect(cmd).toBeTruthy();
    expect(cmd!.label).toBe('Planner');
    expect(cmd!.description).toBe('Select planner backend');
  });

  it('opens planner-picker overlay', () => {
    const openOverlay = vi.fn();
    const commands = createCommands({ ...makeCtx(), openOverlay });
    findCommand(commands, '/planner')!.handler();
    expect(openOverlay).toHaveBeenCalledWith('planner-picker');
  });
});

describe('/home command', () => {
  it('calls ctx.navigate with home', () => {
    const navigate = vi.fn();
    const commands = createCommands({ ...makeCtx(), navigate });
    findCommand(commands, '/home')!.handler();
    expect(navigate).toHaveBeenCalledWith('home');
  });

  it('is only valid on workflow and summary screens', () => {
    const commands = createCommands(makeCtx());
    const cmd = findCommand(commands, '/home')!;
    expect(cmd.validScreens).toEqual(['workflow', 'summary']);
  });
});

describe('/config alias', () => {
  it('resolves /config to /settings', () => {
    const commands = createCommands(makeCtx());
    const cmd = findCommand(commands, '/config');
    expect(cmd).toBeTruthy();
    expect(cmd!.name).toBe('/settings');
  });
});

describe('/implementer command', () => {
  it('has correct label and description', () => {
    const commands = createCommands(makeCtx());
    const cmd = findCommand(commands, '/implementer');
    expect(cmd).toBeTruthy();
    expect(cmd!.label).toBe('Implementer');
    expect(cmd!.description).toBe('Select implementer backend');
  });

  it('opens implementer-picker overlay', () => {
    const openOverlay = vi.fn();
    const commands = createCommands({ ...makeCtx(), openOverlay });
    findCommand(commands, '/implementer')!.handler();
    expect(openOverlay).toHaveBeenCalledWith('implementer-picker');
  });
});
