import { describe, it, expect, vi } from 'vitest';
import { createCommands, toPaletteItems, executeSlashCommand } from './definitions.js';
import type { SlashCommandDef, CommandContext } from '../types/index.js';

const noop = () => {};
const noopTrue = () => true;

function makeCtx(overrides: Partial<CommandContext> = {}): CommandContext {
  return {
    openOverlay: noop,
    navigate: noop,
    quit: noop,
    setWorkflowMode: noopTrue,
    setFeedbackMessage: noop,
    setFeedbackError: noop,
    refreshDetection: async () => {},
    getCurrentPhase: () => 'idle',
    requestRewind: noopTrue,
    requestTaskRedo: noopTrue,
    getQueueDepth: () => 0,
    clearQueue: () => 0,
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
    const setWorkflowMode = vi.fn(() => true);
    const setFeedbackMessage = vi.fn();
    const commands = createCommands(makeCtx({ openOverlay, setWorkflowMode, setFeedbackMessage }));
    executeSlashCommand(commands, '/mode quick', 'home', noop);
    expect(setWorkflowMode).toHaveBeenCalledWith('quick');
    expect(setFeedbackMessage).toHaveBeenCalledWith(expect.stringContaining('quick'));
    expect(openOverlay).not.toHaveBeenCalled();
  });

  it('sets mode to full', () => {
    const setWorkflowMode = vi.fn(() => true);
    const commands = createCommands(makeCtx({ setWorkflowMode }));
    executeSlashCommand(commands, '/mode full', 'home', noop);
    expect(setWorkflowMode).toHaveBeenCalledWith('full');
  });

  it('does not show success feedback when mode save fails', () => {
    const setWorkflowMode = vi.fn(() => false);
    const setFeedbackMessage = vi.fn();
    const commands = createCommands(makeCtx({ setWorkflowMode, setFeedbackMessage }));
    executeSlashCommand(commands, '/mode quick', 'home', noop);
    expect(setWorkflowMode).toHaveBeenCalledWith('quick');
    expect(setFeedbackMessage).not.toHaveBeenCalled();
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

describe('/revise-spec command', () => {
  it('calls requestRewind with spec target and comment', () => {
    const requestRewind = vi.fn(() => true);
    const commands = createCommands(makeCtx({ requestRewind, getCurrentPhase: () => 'implementing' }));
    executeSlashCommand(commands, '/revise-spec needs more detail', 'workflow', noop);
    expect(requestRewind).toHaveBeenCalledWith('spec', 'needs more detail');
  });

  it('calls requestRewind with spec target when no comment', () => {
    const requestRewind = vi.fn(() => true);
    const commands = createCommands(makeCtx({ requestRewind, getCurrentPhase: () => 'implementing' }));
    executeSlashCommand(commands, '/revise-spec', 'workflow', noop);
    expect(requestRewind).toHaveBeenCalledWith('spec', undefined);
  });

  it('shows error when phase is too early', () => {
    const setFeedbackError = vi.fn();
    const requestRewind = vi.fn(() => true);
    const commands = createCommands(makeCtx({ setFeedbackError, requestRewind, getCurrentPhase: () => 'researching' }));
    executeSlashCommand(commands, '/revise-spec', 'workflow', noop);
    expect(setFeedbackError).toHaveBeenCalledWith(expect.stringContaining('only available'));
    expect(requestRewind).not.toHaveBeenCalled();
  });

  it('shows error when requestRewind returns false', () => {
    const setFeedbackError = vi.fn();
    const commands = createCommands(makeCtx({ setFeedbackError, requestRewind: () => false, getCurrentPhase: () => 'implementing' }));
    executeSlashCommand(commands, '/revise-spec', 'workflow', noop);
    expect(setFeedbackError).toHaveBeenCalledWith(expect.stringContaining('Cannot rewind'));
  });

  it('has phaseGuard set', () => {
    const commands = createCommands(makeCtx());
    const cmd = commands.find(c => c.name === '/revise-spec');
    expect(cmd?.phaseGuard).toBeDefined();
  });
});

describe('/revise-plan command', () => {
  it('calls requestRewind with plan target and comment', () => {
    const requestRewind = vi.fn(() => true);
    const commands = createCommands(makeCtx({ requestRewind, getCurrentPhase: () => 'implementing' }));
    executeSlashCommand(commands, '/revise-plan too many tasks', 'workflow', noop);
    expect(requestRewind).toHaveBeenCalledWith('plan', 'too many tasks');
  });

  it('shows error when phase is too early', () => {
    const setFeedbackError = vi.fn();
    const requestRewind = vi.fn(() => true);
    const commands = createCommands(makeCtx({ setFeedbackError, requestRewind, getCurrentPhase: () => 'specifying' }));
    executeSlashCommand(commands, '/revise-plan', 'workflow', noop);
    expect(setFeedbackError).toHaveBeenCalledWith(expect.stringContaining('only available'));
    expect(requestRewind).not.toHaveBeenCalled();
  });

  it('has phaseGuard set', () => {
    const commands = createCommands(makeCtx());
    const cmd = commands.find(c => c.name === '/revise-plan');
    expect(cmd?.phaseGuard).toBeDefined();
  });
});

describe('/redo-task command', () => {
  it('calls requestTaskRedo with task ID', () => {
    const requestTaskRedo = vi.fn(() => true);
    const commands = createCommands(makeCtx({ requestTaskRedo, getCurrentPhase: () => 'implementing' }));
    executeSlashCommand(commands, '/redo-task T001', 'workflow', noop);
    expect(requestTaskRedo).toHaveBeenCalledWith('T001');
  });

  it('shows error when no task ID given', () => {
    const setFeedbackError = vi.fn();
    const requestTaskRedo = vi.fn(() => true);
    const commands = createCommands(makeCtx({ setFeedbackError, requestTaskRedo, getCurrentPhase: () => 'implementing' }));
    executeSlashCommand(commands, '/redo-task', 'workflow', noop);
    expect(setFeedbackError).toHaveBeenCalledWith(expect.stringContaining('requires a task ID'));
    expect(requestTaskRedo).not.toHaveBeenCalled();
  });

  it('shows error when phase does not allow redo', () => {
    const setFeedbackError = vi.fn();
    const requestTaskRedo = vi.fn(() => true);
    const commands = createCommands(makeCtx({ setFeedbackError, requestTaskRedo, getCurrentPhase: () => 'planning' }));
    executeSlashCommand(commands, '/redo-task T001', 'workflow', noop);
    expect(setFeedbackError).toHaveBeenCalledWith(expect.stringContaining('only available'));
    expect(requestTaskRedo).not.toHaveBeenCalled();
  });

  it('has phaseGuard set', () => {
    const commands = createCommands(makeCtx());
    const cmd = commands.find(c => c.name === '/redo-task');
    expect(cmd?.phaseGuard).toBeDefined();
  });
});
