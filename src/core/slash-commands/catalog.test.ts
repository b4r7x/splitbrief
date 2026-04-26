import { beforeEach, describe, it, expect } from 'vitest';
import { createCommands, canReviseSpec, canRevisePlan, canRedoTask } from './catalog.js';
import { toPaletteItems, executeSlashCommand } from './dispatch.js';
import type { SlashCommandDef, CommandContext } from './types.js';
import type { Phase } from '../schemas/enums.js';
import { PHASES } from '../schemas/enums.js';
import { overlayStore } from '../../stores/ui/overlay.js';

const noop = () => {};
const noopTrue = () => true;

function makeCtx(overrides: Partial<CommandContext> = {}): CommandContext {
  return {
    openOverlay: (type, focus) => overlayStore.open(type, focus),
    navigate: noop,
    quit: noop,
    setWorkflowMode: noopTrue,
    setPlannerEffort: noopTrue,
    setFeedbackMessage: noop,
    setFeedbackError: noop,
    refreshDetection: async () => {},
    getCurrentPhase: () => 'idle',
    requestRewind: noopTrue,
    requestTaskRedo: noopTrue,
    getQueueDepth: () => 0,
    clearQueue: () => 0,
    rebuildRepomap: async () => ({ deleted: false, files: [] }),
    attachImage: () => ({ ok: false, reason: 'not-image' }),
    detachImage: () => false,
    listAttachments: () => [],
    writeHandoff: async () => ({ outputDir: '/fake' }),
    listApprovals: () => [],
    clearApprovals: () => 0,
    acceptRunSnapshot: async () => ({ snapshotId: 'snap-accepted', isFirstSnapshot: false }),
    rejectRunSnapshot: async () => ({
      status: 'rejected',
      snapshotId: 'snap-run',
      restoredPaths: [],
      deletedPaths: [],
      conflictedPaths: [],
      missingSnapshotFiles: [],
    }),
    ...overrides,
  };
}

beforeEach(() => {
  overlayStore.reset();
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
      { kind: 'noarg', name: '/no-label', description: 'test', validScreens: ['home'], handler: noop },
      { kind: 'noarg', name: '/with-label', label: 'Labeled', description: 'test', validScreens: ['home'], handler: noop },
    ];
    const items = toPaletteItems(cmds);
    expect(items.length).toBe(1);
    expect(items[0]?.label).toBe('Labeled');
  });
});

describe('executeSlashCommand', () => {
  it('runs the command when it is valid on the current screen', () => {
    let called = false;
    const cmds: SlashCommandDef[] = [
      { kind: 'noarg', name: '/test', description: 'test', validScreens: ['home'], handler: () => { called = true; } },
    ];
    executeSlashCommand(cmds, '/test', 'home', noop);
    expect(called).toBeTruthy();
  });

  it('reports an error for an unknown command', () => {
    let errorMsg = '';
    executeSlashCommand([], '/nope', 'home', (msg) => { errorMsg = msg; });
    expect(errorMsg).toContain('Unknown command');
  });

  it('reports an error when the command is not valid on the current screen', () => {
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
  it('opens mode-selector overlay when called without args (observed via overlayStore)', () => {
    const commands = createCommands(makeCtx());
    executeSlashCommand(commands, '/mode', 'home', noop);
    expect(overlayStore.get().active).toBe('mode-selector');
  });

  it('sets mode to quick without opening the overlay', () => {
    let savedMode: string | undefined;
    let feedback: string | undefined;
    const commands = createCommands(makeCtx({
      setWorkflowMode: (m) => { savedMode = m; return true; },
      setFeedbackMessage: (m) => { feedback = m; },
    }));
    executeSlashCommand(commands, '/mode quick', 'home', noop);
    expect(savedMode).toBe('quick');
    expect(feedback).toMatch(/quick/);
    expect(overlayStore.get().active).toBe('none');
  });

  it('sets mode to speckit', () => {
    let savedMode: string | undefined;
    const commands = createCommands(makeCtx({
      setWorkflowMode: (m) => { savedMode = m; return true; },
    }));
    executeSlashCommand(commands, '/mode speckit', 'home', noop);
    expect(savedMode).toBe('speckit');
  });

  it('does not show success feedback when setWorkflowMode reports failure', () => {
    let feedback: string | undefined;
    const commands = createCommands(makeCtx({
      setWorkflowMode: () => false,
      setFeedbackMessage: (m) => { feedback = m; },
    }));
    executeSlashCommand(commands, '/mode quick', 'home', noop);
    expect(feedback).toBeUndefined();
  });

  it('rejects invalid mode and surfaces an error', () => {
    let savedMode: string | undefined;
    let error: string | undefined;
    const commands = createCommands(makeCtx({
      setWorkflowMode: (m) => { savedMode = m; return true; },
      setFeedbackError: (m) => { error = m; },
    }));
    executeSlashCommand(commands, '/mode turbo', 'home', noop);
    expect(savedMode).toBeUndefined();
    expect(error).toMatch(/invalid/i);
  });
});

describe('/refresh command', () => {
  it('runs detection and surfaces a status message to the user', async () => {
    let refreshRan = false;
    const messages: string[] = [];
    const commands = createCommands(makeCtx({
      refreshDetection: async () => { refreshRan = true; },
      setFeedbackMessage: (m) => { messages.push(m); },
    }));
    executeSlashCommand(commands, '/refresh', 'home', noop);
    // /refresh chains an async: we wait a microtask for the promise chain to complete.
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(refreshRan).toBe(true);
    expect(messages.length).toBeGreaterThan(0);
  });
});

describe('/planner command', () => {
  it('opens the planner-picker overlay (observed via overlayStore)', () => {
    const commands = createCommands(makeCtx());
    executeSlashCommand(commands, '/planner', 'home', noop);
    expect(overlayStore.get().active).toBe('planner-picker');
  });
});

type RewindCall = { target: string; comment: string | undefined };
type RedoCall = { taskId: string };

describe('/revise-spec command', () => {
  it('forwards target=spec and the trimmed comment to the engine', () => {
    const rewinds: RewindCall[] = [];
    const commands = createCommands(makeCtx({
      requestRewind: (target, comment) => { rewinds.push({ target, comment }); return true; },
      getCurrentPhase: () => 'implementing',
    }));
    executeSlashCommand(commands, '/revise-spec needs more detail', 'workflow', noop);
    expect(rewinds).toEqual([{ target: 'spec', comment: 'needs more detail' }]);
  });

  it('forwards target=spec with no comment when none is given', () => {
    const rewinds: RewindCall[] = [];
    const commands = createCommands(makeCtx({
      requestRewind: (target, comment) => { rewinds.push({ target, comment }); return true; },
      getCurrentPhase: () => 'implementing',
    }));
    executeSlashCommand(commands, '/revise-spec', 'workflow', noop);
    expect(rewinds).toEqual([{ target: 'spec', comment: undefined }]);
  });

  it('does NOT call the engine and surfaces a guard error when phase is too early', () => {
    const rewinds: RewindCall[] = [];
    let error: string | undefined;
    const commands = createCommands(makeCtx({
      requestRewind: (t, c) => { rewinds.push({ target: t, comment: c }); return true; },
      setFeedbackError: (m) => { error = m; },
      getCurrentPhase: () => 'researching',
    }));
    executeSlashCommand(commands, '/revise-spec', 'workflow', noop);
    expect(rewinds).toEqual([]);
    expect(error).toMatch(/only available|not available|cannot/i);
  });

  it('surfaces a guard error when the engine rejects the rewind', () => {
    let error: string | undefined;
    const commands = createCommands(makeCtx({
      requestRewind: () => false,
      setFeedbackError: (m) => { error = m; },
      getCurrentPhase: () => 'implementing',
    }));
    executeSlashCommand(commands, '/revise-spec', 'workflow', noop);
    expect(error).toMatch(/cannot rewind|no active/i);
  });
});

describe('/revise-plan command', () => {
  it('forwards target=plan and the trimmed comment to the engine', () => {
    const rewinds: RewindCall[] = [];
    const commands = createCommands(makeCtx({
      requestRewind: (t, c) => { rewinds.push({ target: t, comment: c }); return true; },
      getCurrentPhase: () => 'implementing',
    }));
    executeSlashCommand(commands, '/revise-plan too many tasks', 'workflow', noop);
    expect(rewinds).toEqual([{ target: 'plan', comment: 'too many tasks' }]);
  });

  it('does NOT call the engine and surfaces a guard error when phase is too early', () => {
    const rewinds: RewindCall[] = [];
    let error: string | undefined;
    const commands = createCommands(makeCtx({
      requestRewind: (t, c) => { rewinds.push({ target: t, comment: c }); return true; },
      setFeedbackError: (m) => { error = m; },
      getCurrentPhase: () => 'specifying',
    }));
    executeSlashCommand(commands, '/revise-plan', 'workflow', noop);
    expect(rewinds).toEqual([]);
    expect(error).toMatch(/only available|not available|cannot/i);
  });
});

describe('/redo-task command', () => {
  it('forwards the task ID to the engine', () => {
    const redos: RedoCall[] = [];
    const commands = createCommands(makeCtx({
      requestTaskRedo: (id) => { redos.push({ taskId: id }); return true; },
      getCurrentPhase: () => 'implementing',
    }));
    executeSlashCommand(commands, '/redo-task T001', 'workflow', noop);
    expect(redos).toEqual([{ taskId: 'T001' }]);
  });

  it('does NOT call the engine and surfaces a usage error when no task ID is given', () => {
    const redos: RedoCall[] = [];
    let error: string | undefined;
    const commands = createCommands(makeCtx({
      requestTaskRedo: (id) => { redos.push({ taskId: id }); return true; },
      setFeedbackError: (m) => { error = m; },
      getCurrentPhase: () => 'implementing',
    }));
    executeSlashCommand(commands, '/redo-task', 'workflow', noop);
    expect(redos).toEqual([]);
    expect(error).toMatch(/task id/i);
  });

  it('does NOT call the engine and surfaces a guard error when phase does not allow redo', () => {
    const redos: RedoCall[] = [];
    let error: string | undefined;
    const commands = createCommands(makeCtx({
      requestTaskRedo: (id) => { redos.push({ taskId: id }); return true; },
      setFeedbackError: (m) => { error = m; },
      getCurrentPhase: () => 'planning',
    }));
    executeSlashCommand(commands, '/redo-task T001', 'workflow', noop);
    expect(redos).toEqual([]);
    expect(error).toMatch(/only available|not available/i);
  });
});

describe('canReviseSpec', () => {
  const allowed: Phase[] = ['reviewing-spec', 'clarifying', 'constitution-check', 'planning', 'reviewing-plan', 'reviewing-briefs', 'analyzing', 'implementing', 'validating-task', 'escalating', 'final-review'];
  const denied: Phase[] = ['idle', 'researching', 'specifying', 'complete'];

  it.each(allowed)('returns true for %s', (phase) => {
    expect(canReviseSpec(phase)).toBe(true);
  });

  it.each(denied)('returns false for %s', (phase) => {
    expect(canReviseSpec(phase)).toBe(false);
  });

  it('covers all phases', () => {
    expect([...allowed, ...denied].sort()).toEqual([...PHASES].sort());
  });
});

describe('canRevisePlan', () => {
  const allowed: Phase[] = ['reviewing-plan', 'reviewing-briefs', 'analyzing', 'implementing', 'validating-task', 'escalating', 'final-review'];
  const denied: Phase[] = ['idle', 'researching', 'specifying', 'reviewing-spec', 'clarifying', 'constitution-check', 'planning', 'complete'];

  it.each(allowed)('returns true for %s', (phase) => {
    expect(canRevisePlan(phase)).toBe(true);
  });

  it.each(denied)('returns false for %s', (phase) => {
    expect(canRevisePlan(phase)).toBe(false);
  });

  it('covers all phases', () => {
    expect([...allowed, ...denied].sort()).toEqual([...PHASES].sort());
  });
});

describe('/repomap rebuild command', () => {
  it('calls rebuildRepomap and surfaces success message when cache was present', async () => {
    const messages: string[] = [];
    const commands = createCommands(makeCtx({
      rebuildRepomap: async () => ({ deleted: true, files: ['/proj/.diptych/repomap.sqlite'] }),
      setFeedbackMessage: (m) => { messages.push(m); },
    }));
    executeSlashCommand(commands, '/repomap rebuild', 'home', noop);
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(messages.length).toBeGreaterThan(0);
    expect(messages[0]).toMatch(/cleared/i);
  });

  it('calls rebuildRepomap and surfaces not-present message when no cache exists', async () => {
    const messages: string[] = [];
    const commands = createCommands(makeCtx({
      rebuildRepomap: async () => ({ deleted: false, files: [] }),
      setFeedbackMessage: (m) => { messages.push(m); },
    }));
    executeSlashCommand(commands, '/repomap rebuild', 'home', noop);
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(messages.length).toBeGreaterThan(0);
    expect(messages[0]).toMatch(/not present/i);
  });

  it('surfaces a usage error for unknown sub-commands', () => {
    let error: string | undefined;
    const commands = createCommands(makeCtx({
      setFeedbackError: (m) => { error = m; },
    }));
    executeSlashCommand(commands, '/repomap purge', 'home', noop);
    expect(error).toMatch(/unknown repomap/i);
  });

  it('surfaces a usage error when called with no sub-command', () => {
    let error: string | undefined;
    const commands = createCommands(makeCtx({
      setFeedbackError: (m) => { error = m; },
    }));
    executeSlashCommand(commands, '/repomap', 'home', noop);
    expect(error).toMatch(/unknown repomap/i);
  });
});

describe('canRedoTask', () => {
  const allowed: Phase[] = ['implementing', 'validating-task', 'escalating'];
  const denied: Phase[] = ['idle', 'researching', 'specifying', 'reviewing-spec', 'clarifying', 'constitution-check', 'planning', 'reviewing-plan', 'reviewing-briefs', 'analyzing', 'final-review', 'complete'];

  it.each(allowed)('returns true for %s', (phase) => {
    expect(canRedoTask(phase)).toBe(true);
  });

  it.each(denied)('returns false for %s', (phase) => {
    expect(canRedoTask(phase)).toBe(false);
  });

  it('covers all phases', () => {
    expect([...allowed, ...denied].sort()).toEqual([...PHASES].sort());
  });
});

describe('/handoff command', () => {
  it('appears in catalog with validScreens including workflow and summary', () => {
    const commands = createCommands(makeCtx());
    const cmd = commands.find((c) => c.name === '/handoff');
    expect(cmd).toBeDefined();
    expect(cmd?.validScreens).toContain('workflow');
    expect(cmd?.validScreens).toContain('summary');
  });

  it('calls setFeedbackError with usage hint when no args given', () => {
    let error: string | undefined;
    const commands = createCommands(makeCtx({ setFeedbackError: (m) => { error = m; } }));
    executeSlashCommand(commands, '/handoff', 'workflow', noop);
    expect(error).toMatch(/usage/i);
  });

  it('calls setFeedbackError mentioning valid targets for unknown target', () => {
    let error: string | undefined;
    const commands = createCommands(makeCtx({ setFeedbackError: (m) => { error = m; } }));
    executeSlashCommand(commands, '/handoff unknown-target', 'workflow', noop);
    expect(error).toMatch(/valid/i);
    expect(error).toContain('spec-kit');
  });

  it('calls writeHandoff with spec-kit and no taskId', async () => {
    const calls: Array<{ target: string; taskId: string | undefined }> = [];
    const commands = createCommands(makeCtx({
      writeHandoff: async (target, taskId) => { calls.push({ target, taskId }); return { outputDir: '/fake' }; },
    }));
    executeSlashCommand(commands, '/handoff spec-kit', 'workflow', noop);
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(calls).toEqual([{ target: 'spec-kit', taskId: undefined }]);
  });

  it('calls writeHandoff with claude-code and task id T003', async () => {
    const calls: Array<{ target: string; taskId: string | undefined }> = [];
    const commands = createCommands(makeCtx({
      writeHandoff: async (target, taskId) => { calls.push({ target, taskId }); return { outputDir: '/fake' }; },
    }));
    executeSlashCommand(commands, '/handoff claude-code T003', 'workflow', noop);
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(calls).toEqual([{ target: 'claude-code', taskId: 'T003' }]);
  });

  it('calls setFeedbackMessage containing output path on success', async () => {
    let message: string | undefined;
    const commands = createCommands(makeCtx({
      writeHandoff: async () => ({ outputDir: '/proj/.diptych/sessions/s1/handoffs/spec-kit' }),
      setFeedbackMessage: (m) => { message = m; },
    }));
    executeSlashCommand(commands, '/handoff spec-kit', 'workflow', noop);
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(message).toContain('/proj/.diptych/sessions/s1/handoffs/spec-kit');
  });

  it('calls setFeedbackError when writeHandoff rejects', async () => {
    let error: string | undefined;
    const commands = createCommands(makeCtx({
      writeHandoff: async () => { throw new Error('No active session for handoff'); },
      setFeedbackError: (m) => { error = m; },
    }));
    executeSlashCommand(commands, '/handoff spec-kit', 'workflow', noop);
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(error).toContain('No active session for handoff');
  });
});

describe('run snapshot slash commands', () => {
  it('accepts the current run and surfaces the snapshot id', async () => {
    let message: string | undefined;
    const commands = createCommands(makeCtx({
      acceptRunSnapshot: async () => ({ snapshotId: 'snap-1', isFirstSnapshot: false }),
      setFeedbackMessage: (m) => { message = m; },
    }));
    executeSlashCommand(commands, '/accept-run', 'workflow', noop);
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(message).toContain('snap-1');
  });

  it('requires explicit confirmation before rejecting a run', () => {
    let called = false;
    let error: string | undefined;
    const commands = createCommands(makeCtx({
      rejectRunSnapshot: async () => {
        called = true;
        return { status: 'empty' };
      },
      setFeedbackError: (m) => { error = m; },
    }));
    executeSlashCommand(commands, '/reject-run', 'workflow', noop);
    expect(called).toBe(false);
    expect(error).toMatch(/confirm/i);
  });

  it('rejects the current run after confirmation and reports changed files', async () => {
    let message: string | undefined;
    const commands = createCommands(makeCtx({
      rejectRunSnapshot: async () => ({
        status: 'rejected',
        snapshotId: 'snap-2',
        restoredPaths: ['src/a.ts'],
        deletedPaths: ['src/b.ts'],
        conflictedPaths: [],
        missingSnapshotFiles: [],
      }),
      setFeedbackMessage: (m) => { message = m; },
    }));
    executeSlashCommand(commands, '/reject-run confirm', 'workflow', noop);
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(message).toContain('2 file(s)');
    expect(message).toContain('snap-2');
  });

  it('surfaces conflicts as an error when rejecting a run', async () => {
    let error: string | undefined;
    const commands = createCommands(makeCtx({
      rejectRunSnapshot: async () => ({
        status: 'rejected',
        snapshotId: 'snap-3',
        restoredPaths: [],
        deletedPaths: [],
        conflictedPaths: ['src/a.ts'],
        missingSnapshotFiles: [],
      }),
      setFeedbackError: (m) => { error = m; },
    }));
    executeSlashCommand(commands, '/reject-run confirm', 'workflow', noop);
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(error).toMatch(/conflict/i);
  });
});
