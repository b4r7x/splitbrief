import { describe, it, expect } from 'vitest';
import type { RuntimeCommandDef } from './types.js';
import { executeRuntimeCommand as dispatchRuntimeCommand } from './dispatch.js';
import { noop, runCommandInTest } from '#testing/helpers/runtime-commands.js';

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
    runCommandInTest({ commands: cmds, raw: '/test', screen: 'home', onError: noop });
    expect(called).toBeTruthy();
  });

  it('reports an error for an unknown command', () => {
    let errorMsg = '';
    runCommandInTest({
      commands: [],
      raw: '/nope',
      screen: 'home',
      onError: (msg) => {
        errorMsg = msg;
      },
    });
    expect(errorMsg).toBe('Unknown command: /nope. Type /help for available commands.');
  });

  it('points a removed command at its replacement instead of reporting it unknown', async () => {
    let errorMsg = '';
    await runCommandInTest({
      commands: [],
      raw: '/effort high',
      screen: 'home',
      onError: (msg) => {
        errorMsg = msg;
      },
    });
    expect(errorMsg).toContain('/crew plan');
    expect(errorMsg).not.toContain('Unknown command');
  });

  it('passes the typed arguments to the handler and nothing when none were typed', async () => {
    const received: (string | undefined)[] = [];
    const cmds: RuntimeCommandDef[] = [
      {
        kind: 'arg',
        name: '/run',
        description: 'run',
        category: 'workflow',
        args: { kind: 'closed', options: ['accept', 'reject'] },
        validScreens: ['home'],
        handler: (args) => {
          received.push(args);
        },
      },
    ];

    await runCommandInTest({ commands: cmds, raw: '/run', screen: 'home', onError: noop });
    await runCommandInTest({ commands: cmds, raw: '/run reject', screen: 'home', onError: noop });

    expect(received).toEqual([undefined, 'reject']);
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
        name: '/revise-plan',
        description: 'revise plan',
        category: 'workflow',
        args: { kind: 'free', hint: '<confirm>' },
        validScreens: ['home'],
        handler: (args) => {
          calls.push(`revise:${args ?? ''}`);
        },
      },
    ];

    await runCommandInTest({
      commands: cmds,
      raw: '/mde',
      screen: 'home',
      onError: (msg) => {
        errorMsg = msg;
      },
    });
    expect(calls).toEqual([]);
    expect(errorMsg).toBe('Unknown command: /mde. Did you mean /mode?');

    await runCommandInTest({
      commands: cmds,
      raw: '/revise-pln feedback',
      screen: 'home',
      onError: (msg) => {
        errorMsg = msg;
      },
    });
    expect(calls).toEqual([]);
    expect(errorMsg).toBe('Unknown command: /revise-pln. Did you mean /revise-plan?');
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
    runCommandInTest({
      commands: cmds,
      raw: '/test-home-only',
      screen: 'workflow',
      onError: (msg) => {
        errorMsg = msg;
      },
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
    runCommandInTest({ commands: cmds, raw: '/test hello world', screen: 'home', onError: noop });
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
    runCommandInTest({ commands: cmds, raw: '/test', screen: 'home', onError: noop });
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

    await runCommandInTest({
      commands: cmds,
      raw: '/copy path',
      screen: 'workflow',
      onError: noop,
    });
    await runCommandInTest({
      commands: cmds,
      raw: '/queue clear',
      screen: 'workflow',
      onError: noop,
    });

    expect(received).toEqual(['copy:path', 'queue:clear']);
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
    await runCommandInTest({ commands: cmds, raw: '/async', screen: 'home', onError: noop });
    expect(called).toBe(true);
  });
});
