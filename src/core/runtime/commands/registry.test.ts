import { describe, it, expect } from 'vitest';
import { createRuntimeCommands } from './registry.js';
import { makeCtx, executeRuntimeCommand } from '#testing/helpers/runtime-commands.js';

const ATTACHED_LOCAL_ONLY = [
  '/skills',
  '/settings',
  '/mode',
  '/effort',
  '/planner',
  '/implementer',
  '/refresh',
  '/revise-spec',
  '/revise-plan',
  '/redo-task',
  '/handoff',
  '/export',
  '/compact-transcript',
  '/repomap',
  '/attach',
  '/detach',
  '/approval',
  '/accept-run',
  '/reject-run',
  '/yolo',
] as const;

const ATTACHED_AVAILABLE = [
  '/help',
  '/palette',
  '/sessions',
  '/copy',
  '/home',
  '/scroll',
  '/activity',
  '/sidebar',
  '/queue',
  '/quit',
] as const;

function names(ctxOverrides: Parameters<typeof makeCtx>[0]): string[] {
  return createRuntimeCommands(makeCtx(ctxOverrides)).map((cmd) => cmd.name);
}

describe('createRuntimeCommands attached-client gating', () => {
  it('exposes local-only workflow mutation commands for in-process clients', () => {
    const exposed = names({ isAttached: false });
    for (const name of ATTACHED_LOCAL_ONLY) {
      expect(exposed).toContain(name);
    }
  });

  it('hides local-only and config-mutating commands from attached clients', () => {
    const exposed = names({ isAttached: true });
    for (const name of ATTACHED_LOCAL_ONLY) {
      expect(exposed).not.toContain(name);
    }
  });

  it('keeps server-safe commands available for attached clients', () => {
    const exposed = names({ isAttached: true });
    expect(exposed).toEqual([...ATTACHED_AVAILABLE]);
    for (const name of ATTACHED_AVAILABLE) {
      expect(exposed).toContain(name);
    }
  });

  it('does not mutate attached-client workflow mode or planner effort', async () => {
    let modeSet = false;
    let effortSet = false;
    const commands = createRuntimeCommands(
      makeCtx({
        isAttached: true,
        setWorkflowMode: () => {
          modeSet = true;
          return true;
        },
        setPlannerEffort: () => {
          effortSet = true;
          return true;
        },
      }),
    );
    const errors: string[] = [];

    await executeRuntimeCommand(commands, '/mode quick', 'workflow', (message) =>
      errors.push(message),
    );
    await executeRuntimeCommand(commands, '/effort high', 'workflow', (message) =>
      errors.push(message),
    );

    expect(modeSet).toBe(false);
    expect(effortSet).toBe(false);
    expect(errors).toHaveLength(2);
    expect(errors.every((message) => /unknown command/i.test(message))).toBe(true);
  });

  it('does not mutate the attached client approval state when /yolo is dispatched', async () => {
    let approvalSet: boolean | null = null;
    const commands = createRuntimeCommands(
      makeCtx({
        isAttached: true,
        setApprovalEnabled: (value) => {
          approvalSet = value;
        },
      }),
    );
    let error = '';
    await executeRuntimeCommand(commands, '/yolo', 'workflow', (message) => {
      error = message;
    });

    expect(approvalSet).toBeNull();
    expect(error).toMatch(/unknown command/i);
  });

  it('does not attach an image locally when /attach is dispatched from an attached client', async () => {
    let attachCalled = false;
    const commands = createRuntimeCommands(
      makeCtx({
        isAttached: true,
        attachImage: () => {
          attachCalled = true;
          return { ok: true, path: '/tmp/x.png' };
        },
      }),
    );
    let error = '';
    await executeRuntimeCommand(commands, '/attach /tmp/x.png', 'workflow', (message) => {
      error = message;
    });

    expect(attachCalled).toBe(false);
    expect(error).toMatch(/unknown command/i);
  });

  it('does not request a local rewind when /revise-spec is dispatched from an attached client', async () => {
    let rewindCalled = false;
    const commands = createRuntimeCommands(
      makeCtx({
        isAttached: true,
        requestRewind: () => {
          rewindCalled = true;
          return true;
        },
        getCurrentPhase: () => 'implementing',
      }),
    );
    let error = '';
    await executeRuntimeCommand(
      commands,
      '/revise-spec needs detail',
      'workflow',
      (message) => {
        error = message;
      },
      'implementing',
    );

    expect(rewindCalled).toBe(false);
    expect(error).toMatch(/unknown command/i);
  });
});
