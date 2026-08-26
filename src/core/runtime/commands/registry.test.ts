import { describe, it, expect } from 'vitest';
import { ATTACHED_AVAILABLE_COMMANDS, createRuntimeCommands } from './registry.js';
import { makeCtx } from '#testing/helpers/runtime-commands.js';

const ATTACHED_LOCAL_ONLY = [
  '/skills',
  '/settings',
  '/mode',
  '/crew',
  '/refresh',
  '/revise-spec',
  '/revise-plan',
  '/redo-task',
  '/handoff',
  '/export',
  '/compact-transcript',
  '/image',
  '/approval',
  '/run',
  '/yolo',
  '/diff',
  '/cost',
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

describe('createRuntimeCommands registry shape', () => {
  const commands = createRuntimeCommands(makeCtx({}));

  it('registers the commands the reference documents, once each', () => {
    const registered = commands.map((cmd) => cmd.name);
    expect(registered).toHaveLength(27);
    expect(new Set(registered).size).toBe(27);
  });

  it('files every command under a category and gives every argument command its argument set', () => {
    for (const cmd of commands) {
      expect(cmd.category).toBeDefined();
      if (cmd.kind === 'arg') expect(cmd.args).toBeDefined();
    }
  });

  it('keeps the palette typeable but out of its own list', () => {
    const palette = commands.find((cmd) => cmd.name === '/palette');
    expect(palette?.hidden).toBe(true);
  });

  it('offers images only while the PLAN seat can receive them', () => {
    const image = commands.find((cmd) => cmd.name === '/image');

    expect(
      image?.guard?.({ phase: 'idle', attached: false, plannerSupportsImages: false }),
    ).toBeTypeOf('string');
    expect(
      image?.guard?.({ phase: 'idle', attached: false, plannerSupportsImages: true }),
    ).toBeUndefined();
  });

  it('offers attached clients only names the registry still knows', () => {
    const registered = new Set(commands.map((cmd) => cmd.name));
    for (const name of ATTACHED_AVAILABLE_COMMANDS) {
      expect(registered).toContain(name);
    }
  });
});
