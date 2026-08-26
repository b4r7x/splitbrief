import { describe, it, expect } from 'vitest';
import type { RuntimeCommandDef } from './types.js';
import { executeRuntimeCommand as dispatchRuntimeCommand } from './dispatch.js';
import { noop, executeRuntimeCommand } from '#testing/helpers/runtime-commands.js';

describe('executeRuntimeCommand', () => {
  it('runs the command when it is valid on the current screen', () => {
    let called = false;
    const cmds: RuntimeCommandDef[] = [
      {
        kind: 'noarg',
        name: '/test',
        description: 'test',
        category: 'view',
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

  it('points a removed command at its replacement instead of reporting it unknown', async () => {
    let errorMsg = '';
    await executeRuntimeCommand([], '/effort high', 'home', (msg) => {
      errorMsg = msg;
    });
    expect(errorMsg).toContain('/crew plan');
    expect(errorMsg).not.toContain('Unknown command');
  });

  it('runs an alias with the arguments it carries, ahead of the typed ones', async () => {
    const received: string[] = [];
    const cmds: RuntimeCommandDef[] = [
      {
        kind: 'arg',
        name: '/run',
        aliases: [{ name: '/accept-run', args: 'accept' }],
        description: 'run',
        category: 'workflow',
        args: { kind: 'closed', options: ['accept', 'reject'] },
        validScreens: ['home'],
        handler: (args) => {
          received.push(args ?? '');
        },
      },
    ];

    await executeRuntimeCommand(cmds, '/accept-run', 'home', noop);
    await executeRuntimeCommand(cmds, '/run reject', 'home', noop);

    expect(received).toEqual(['accept', 'reject']);
  });

  it('does not execute a fuzzy command match and suggests the nearest command', async () => {
    const calls: string[] = [];
    let errorMsg = '';
    const cmds: RuntimeCommandDef[] = [
      {
        kind: 'noarg',
        name: '/mode',
        description: 'mode',
        category: 'crew',
        validScreens: ['home'],
        handler: () => {
          calls.push('mode');
        },
      },
      {
        kind: 'arg',
        name: '/reject-run',
        description: 'reject run',
        category: 'workflow',
        args: { kind: 'free', hint: '<confirm>' },
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
        category: 'view',
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
        category: 'view',
        args: { kind: 'free', hint: '<text>' },
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
        category: 'view',
        args: { kind: 'free', hint: '<text>' },
        validScreens: ['home'],
        handler: (args) => {
          receivedArgs = args;
        },
      },
    ];
    executeRuntimeCommand(cmds, '/test', 'home', noop);
    expect(receivedArgs).toBeUndefined();
  });

  it('reports the guard reason and skips the handler when a guard blocks the command', async () => {
    let called = false;
    let errorMsg = '';
    const cmds: RuntimeCommandDef[] = [
      {
        kind: 'noarg',
        name: '/guarded',
        description: 'test',
        category: 'workflow',
        validScreens: ['workflow'],
        guard: (c) => (c.plannerSupportsImages ? undefined : 'PLAN seat cannot see images'),
        handler: () => {
          called = true;
        },
      },
    ];
    await dispatchRuntimeCommand(cmds, '/guarded', {
      screen: 'workflow',
      phase: 'planning',
      attached: false,
      plannerSupportsImages: false,
      onError: (msg) => {
        errorMsg = msg;
      },
    });
    expect(called).toBe(false);
    expect(errorMsg).toBe('PLAN seat cannot see images');
  });

  it('parses argument-bearing slash lines forwarded from the composer', async () => {
    const received: string[] = [];
    const cmds: RuntimeCommandDef[] = [
      {
        kind: 'arg',
        name: '/copy',
        description: 'copy',
        category: 'io',
        args: { kind: 'closed', options: ['path'], optional: true },
        validScreens: ['workflow'],
        handler: (args) => {
          received.push(`copy:${args ?? ''}`);
        },
      },
      {
        kind: 'arg',
        name: '/queue',
        description: 'queue',
        category: 'workflow',
        args: { kind: 'closed', options: ['show', 'clear'], optional: true },
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
        category: 'navigate',
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
        category: 'view',
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
