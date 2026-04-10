import { describe, it, expect, vi } from 'vitest';
import { createCommands, toPaletteItems, executeSlashCommand } from './definitions.js';
import type { SlashCommandDef, CommandContext } from '../types/index.js';

const noop = () => {};

function makeCtx(overrides: Partial<CommandContext> = {}): CommandContext {
  return {
    openOverlay: noop,
    navigate: noop,
    quit: noop,
    setWorkflowMode: noop,
    setFeedbackMessage: noop,
    setFeedbackError: noop,
    refreshDetection: async () => {},
    ...overrides,
  };
}

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
      { kind: 'noarg', name: '/no-label', description: 'test', validScreens: ['home'], handler: noop },
      { kind: 'noarg', name: '/with-label', label: 'Labeled', description: 'test', validScreens: ['home'], handler: noop },
    ];
    const items = toPaletteItems(cmds);
    expect(items.length).toBe(1);
    expect(items[0]?.label).toBe('Labeled');
  });
});

describe('executeSlashCommand', () => {
  it('calls handler for valid command on valid screen', () => {
    let called = false;
    const cmds: SlashCommandDef[] = [
      { kind: 'noarg', name: '/test', description: 'test', validScreens: ['home'], handler: () => { called = true; } },
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
      { kind: 'noarg', name: '/test-home-only', description: 'test', validScreens: ['home'], handler: noop },
    ];
    executeSlashCommand(cmds, '/test-home-only', 'workflow', (msg) => { errorMsg = msg; });
    expect(errorMsg).toContain('only available');
  });

  it('passes args to handler', () => {
    let receivedArgs: string | undefined;
    const cmds: SlashCommandDef[] = [
      { kind: 'arg', name: '/test', description: 'test', validScreens: ['home'], handler: (args) => { receivedArgs = args; } },
    ];
    executeSlashCommand(cmds, '/test hello world', 'home', noop);
    expect(receivedArgs).toBe('hello world');
  });

  it('passes undefined args when no args given', () => {
    let receivedArgs: string | undefined = 'initial';
    const cmds: SlashCommandDef[] = [
      { kind: 'arg', name: '/test', description: 'test', validScreens: ['home'], handler: (args) => { receivedArgs = args; } },
    ];
    executeSlashCommand(cmds, '/test', 'home', noop);
    expect(receivedArgs).toBeUndefined();
  });
});

describe('/mode command', () => {
  it('opens mode selector when called without args', () => {
    const openOverlay = vi.fn();
    const commands = createCommands(makeCtx({ openOverlay }));
    executeSlashCommand(commands, '/mode', 'home', noop);
    expect(openOverlay).toHaveBeenCalledWith('mode-selector');
  });

  it('sets mode to quick without opening overlay', () => {
    const openOverlay = vi.fn();
    const setWorkflowMode = vi.fn();
    const setFeedbackMessage = vi.fn();
    const commands = createCommands(makeCtx({ openOverlay, setWorkflowMode, setFeedbackMessage }));
    executeSlashCommand(commands, '/mode quick', 'home', noop);
    expect(setWorkflowMode).toHaveBeenCalledWith('quick');
    expect(setFeedbackMessage).toHaveBeenCalledWith(expect.stringContaining('quick'));
    expect(openOverlay).not.toHaveBeenCalled();
  });

  it('sets mode to full', () => {
    const setWorkflowMode = vi.fn();
    const commands = createCommands(makeCtx({ setWorkflowMode }));
    executeSlashCommand(commands, '/mode full', 'home', noop);
    expect(setWorkflowMode).toHaveBeenCalledWith('full');
  });

  it('rejects invalid mode', () => {
    const setWorkflowMode = vi.fn();
    const setFeedbackError = vi.fn();
    const commands = createCommands(makeCtx({ setWorkflowMode, setFeedbackError }));
    executeSlashCommand(commands, '/mode turbo', 'home', noop);
    expect(setWorkflowMode).not.toHaveBeenCalled();
    expect(setFeedbackError).toHaveBeenCalledWith(expect.stringContaining('Invalid mode'));
  });
});

describe('/refresh command', () => {
  it('calls refreshDetection and shows feedback', () => {
    const refreshDetection = vi.fn().mockResolvedValue(undefined);
    const setFeedbackMessage = vi.fn();
    const commands = createCommands(makeCtx({ refreshDetection, setFeedbackMessage }));
    executeSlashCommand(commands, '/refresh', 'home', noop);
    expect(refreshDetection).toHaveBeenCalled();
    expect(setFeedbackMessage).toHaveBeenCalledWith(expect.stringContaining('Refresh'));
  });
});

describe('/planner command', () => {
  it('opens planner-picker overlay', () => {
    const openOverlay = vi.fn();
    const commands = createCommands(makeCtx({ openOverlay }));
    executeSlashCommand(commands, '/planner', 'home', noop);
    expect(openOverlay).toHaveBeenCalledWith('planner-picker');
  });
});

