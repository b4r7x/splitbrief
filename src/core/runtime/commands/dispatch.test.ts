import { describe, it, expect } from 'vitest';
import type { RuntimeCommandDef } from './types.js';
import { PHASES } from '../../schemas/enums.js';
import { PHASE_GUARDS, noop, executeRuntimeCommand } from '#testing/helpers/runtime-commands.js';

describe('executeRuntimeCommand', () => {
  it('runs the command when it is valid on the current screen', () => {
    let called = false;
    const cmds: RuntimeCommandDef[] = [
      {
        kind: 'noarg',
        name: '/test',
        description: 'test',
        validScreens: ['home'],
        handler: () => {
          called = true;
        },
      },
    ];
    executeRuntimeCommand(cmds, '/test', 'home', noop);
    expect(called).toBeTruthy();
  });

  it('reports an error for an unknown command', () => {
    let errorMsg = '';
    executeRuntimeCommand([], '/nope', 'home', (msg) => {
      errorMsg = msg;
    });
    expect(errorMsg).toContain('Unknown command');
  });

  it('does not execute a fuzzy command match and suggests the nearest command', async () => {
    const calls: string[] = [];
    let errorMsg = '';
    const cmds: RuntimeCommandDef[] = [
      {
        kind: 'noarg',
        name: '/mode',
        description: 'mode',
        validScreens: ['home'],
        handler: () => {
          calls.push('mode');
        },
      },
      {
        kind: 'arg',
        name: '/reject-run',
        description: 'reject run',
        validScreens: ['home'],
        handler: (args) => {
          calls.push(`reject:${args ?? ''}`);
        },
      },
    ];

    await executeRuntimeCommand(cmds, '/mde', 'home', (msg) => {
      errorMsg = msg;
    });
    expect(calls).toEqual([]);
    expect(errorMsg).toBe('Unknown command: /mde. Did you mean /mode?');

    await executeRuntimeCommand(cmds, '/reject-rn confirm', 'home', (msg) => {
      errorMsg = msg;
    });
    expect(calls).toEqual([]);
    expect(errorMsg).toBe('Unknown command: /reject-rn. Did you mean /reject-run?');
  });

  it('reports an error when the command is not valid on the current screen', () => {
    let errorMsg = '';
    const cmds: RuntimeCommandDef[] = [
      {
        kind: 'noarg',
        name: '/test-home-only',
        description: 'test',
        validScreens: ['home'],
        handler: noop,
      },
    ];
    executeRuntimeCommand(cmds, '/test-home-only', 'workflow', (msg) => {
      errorMsg = msg;
    });
    expect(errorMsg).toContain('only available');
  });

  it('passes args to handler', () => {
    let receivedArgs: string | undefined;
    const cmds: RuntimeCommandDef[] = [
      {
        kind: 'arg',
        name: '/test',
        description: 'test',
        validScreens: ['home'],
        handler: (args) => {
          receivedArgs = args;
        },
      },
    ];
    executeRuntimeCommand(cmds, '/test hello world', 'home', noop);
    expect(receivedArgs).toBe('hello world');
  });

  it('passes undefined args when no args given', () => {
    let receivedArgs: string | undefined = 'initial';
    const cmds: RuntimeCommandDef[] = [
      {
        kind: 'arg',
        name: '/test',
        description: 'test',
        validScreens: ['home'],
        handler: (args) => {
          receivedArgs = args;
        },
      },
    ];
    executeRuntimeCommand(cmds, '/test', 'home', noop);
    expect(receivedArgs).toBeUndefined();
  });

  it('does not execute a command blocked by its phase guard', async () => {
    let called = false;
    let errorMsg = '';
    const cmds: RuntimeCommandDef[] = [
      {
        kind: 'noarg',
        name: '/guarded',
        description: 'test',
        validScreens: ['workflow'],
        phaseGuard: (phase) => phase === 'implementing',
        handler: () => {
          called = true;
        },
      },
    ];
    await executeRuntimeCommand(
      cmds,
      '/guarded',
      'workflow',
      (msg) => {
        errorMsg = msg;
      },
      'planning',
    );
    expect(called).toBe(false);
    expect(errorMsg).toContain('planning');
  });

  it('parses argument-bearing slash lines forwarded from the composer', async () => {
    const received: string[] = [];
    const cmds: RuntimeCommandDef[] = [
      {
        kind: 'arg',
        name: '/copy',
        description: 'copy',
        validScreens: ['workflow'],
        handler: (args) => {
          received.push(`copy:${args ?? ''}`);
        },
      },
      {
        kind: 'arg',
        name: '/queue',
        description: 'queue',
        validScreens: ['workflow'],
        handler: (args) => {
          received.push(`queue:${args ?? ''}`);
        },
      },
    ];

    await executeRuntimeCommand(cmds, '/copy path', 'workflow', noop);
    await executeRuntimeCommand(cmds, '/queue clear', 'workflow', noop);

    expect(received).toEqual(['copy:path', 'queue:clear']);
  });

  it('reports an unknown slash command against a populated registry', async () => {
    let errorMsg = '';
    const cmds: RuntimeCommandDef[] = [
      {
        kind: 'noarg',
        name: '/help',
        description: 'help',
        validScreens: ['home'],
        handler: noop,
      },
    ];

    await executeRuntimeCommand(cmds, '/nope', 'home', (msg) => {
      errorMsg = msg;
    });

    expect(errorMsg).toContain('Unknown command: /nope');
  });

  it('waits for async command handlers', async () => {
    let called = false;
    const cmds: RuntimeCommandDef[] = [
      {
        kind: 'noarg',
        name: '/async',
        description: 'test',
        validScreens: ['home'],
        handler: async () => {
          called = true;
        },
      },
    ];
    await executeRuntimeCommand(cmds, '/async', 'home', noop);
    expect(called).toBe(true);
  });
});

describe('canReviseSpec', () => {
  it.each(PHASE_GUARDS.canReviseSpec.allowed)('returns true for %s', (phase) => {
    expect(PHASE_GUARDS.canReviseSpec.fn(phase)).toBe(true);
  });

  it.each(PHASE_GUARDS.canReviseSpec.denied)('returns false for %s', (phase) => {
    expect(PHASE_GUARDS.canReviseSpec.fn(phase)).toBe(false);
  });
});

describe('canRevisePlan', () => {
  it.each(PHASE_GUARDS.canRevisePlan.allowed)('returns true for %s', (phase) => {
    expect(PHASE_GUARDS.canRevisePlan.fn(phase)).toBe(true);
  });

  it.each(PHASE_GUARDS.canRevisePlan.denied)('returns false for %s', (phase) => {
    expect(PHASE_GUARDS.canRevisePlan.fn(phase)).toBe(false);
  });
});

describe('canRedoTask', () => {
  it.each(PHASE_GUARDS.canRedoTask.allowed)('returns true for %s', (phase) => {
    expect(PHASE_GUARDS.canRedoTask.fn(phase)).toBe(true);
  });

  it.each(PHASE_GUARDS.canRedoTask.denied)('returns false for %s', (phase) => {
    expect(PHASE_GUARDS.canRedoTask.fn(phase)).toBe(false);
  });
});

describe('phase guard coverage', () => {
  it.each(Object.entries(PHASE_GUARDS))('%s covers all phases', (_name, guard) => {
    expect([...guard.allowed, ...guard.denied].sort()).toEqual([...PHASES].sort());
  });
});
