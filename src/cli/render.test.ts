import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTerminationHandler, restoreTerminal } from './render.js';
import { terminalSequences } from '../lib/terminal/control.js';

describe('createTerminationHandler', () => {
  it('cleans up then exits with the conventional code for SIGINT', () => {
    const calls: string[] = [];
    const cleanup = vi.fn(() => calls.push('cleanup'));
    const exit = vi.fn((code: number) => calls.push(`exit:${code}`));

    const handle = createTerminationHandler({ cleanup, exit });
    handle('SIGINT');

    expect(calls).toEqual(['cleanup', 'exit:130']);
  });

  it('exits with 143 for SIGTERM', () => {
    const cleanup = vi.fn();
    const exit = vi.fn();

    const handle = createTerminationHandler({ cleanup, exit });
    handle('SIGTERM');

    expect(exit).toHaveBeenCalledWith(143);
  });

  it('runs only once even if the signal fires repeatedly', () => {
    const cleanup = vi.fn();
    const exit = vi.fn();

    const handle = createTerminationHandler({ cleanup, exit });
    handle('SIGINT');
    handle('SIGINT');
    handle('SIGTERM');

    expect(cleanup).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledTimes(1);
  });

  it('still exits when cleanup throws', () => {
    const cleanup = vi.fn(() => {
      throw new Error('cleanup failed');
    });
    const exit = vi.fn();

    const handle = createTerminationHandler({ cleanup, exit });

    expect(() => handle('SIGINT')).not.toThrow();
    expect(exit).toHaveBeenCalledWith(130);
  });
});

describe('restoreTerminal', () => {
  let originalWrite: typeof process.stdout.write;

  beforeEach(() => {
    originalWrite = process.stdout.write.bind(process.stdout);
  });

  afterEach(() => {
    process.stdout.write = originalWrite;
  });

  it('exits the alternate buffer and unhides the cursor in fullscreen mode', () => {
    const written: string[] = [];
    process.stdout.write = ((chunk: string) => {
      written.push(chunk);
      return true;
    }) as typeof process.stdout.write;

    restoreTerminal({ fullscreen: true });

    expect(written).toEqual([terminalSequences.exitAltBuffer, terminalSequences.showCursor]);
  });

  it('disables mouse and paste modes when requested', () => {
    const written: string[] = [];
    process.stdout.write = ((chunk: string) => {
      written.push(chunk);
      return true;
    }) as typeof process.stdout.write;

    restoreTerminal({ fullscreen: true, mouse: true });

    expect(written).toEqual([
      terminalSequences.disableMouseTracking,
      terminalSequences.disableSgrMouse,
      terminalSequences.disableBracketedPaste,
      terminalSequences.exitAltBuffer,
      terminalSequences.showCursor,
    ]);
  });

  it('writes nothing in non-fullscreen mode', () => {
    const written: string[] = [];
    process.stdout.write = ((chunk: string) => {
      written.push(chunk);
      return true;
    }) as typeof process.stdout.write;

    restoreTerminal({ fullscreen: false });

    expect(written).toEqual([]);
  });
});
