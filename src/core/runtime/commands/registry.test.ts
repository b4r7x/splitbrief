import { describe, it, expect } from 'vitest';
import { createRuntimeCommands } from './registry.js';
import { makeCtx } from '#testing/helpers/runtime-commands.js';

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
  });
});
