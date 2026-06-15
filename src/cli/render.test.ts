import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createCrashHandler,
  createResumeHandler,
  createSuspendHandler,
  createSuspendListenerToggle,
  createTerminationHandler,
  restoreTerminal,
} from './render.js';
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

  it('cleans up then exits with 129 for SIGHUP', () => {
    const calls: string[] = [];
    const cleanup = vi.fn(() => calls.push('cleanup'));
    const exit = vi.fn((code: number) => calls.push(`exit:${code}`));

    const handle = createTerminationHandler({ cleanup, exit });
    handle('SIGHUP');

    expect(calls).toEqual(['cleanup', 'exit:129']);
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

describe('createCrashHandler', () => {
  it('restores the terminal before reporting, then exits non-zero', () => {
    const calls: string[] = [];
    const cleanup = vi.fn(() => calls.push('cleanup'));
    const report = vi.fn((reason: unknown) => calls.push(`report:${String(reason)}`));
    const exit = vi.fn((code: number) => calls.push(`exit:${code}`));

    const handle = createCrashHandler({ cleanup, report, exit });
    handle(new Error('boom'));

    expect(calls).toEqual(['cleanup', 'report:Error: boom', 'exit:1']);
  });

  it('runs only once even if multiple crashes fire', () => {
    const cleanup = vi.fn();
    const report = vi.fn();
    const exit = vi.fn();

    const handle = createCrashHandler({ cleanup, report, exit });
    handle(new Error('first'));
    handle(new Error('second'));

    expect(cleanup).toHaveBeenCalledTimes(1);
    expect(report).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledTimes(1);
  });

  it('still reports and exits when cleanup throws', () => {
    const calls: string[] = [];
    const cleanup = vi.fn(() => {
      throw new Error('cleanup failed');
    });
    const report = vi.fn(() => calls.push('report'));
    const exit = vi.fn((code: number) => calls.push(`exit:${code}`));

    const handle = createCrashHandler({ cleanup, report, exit });

    expect(() => handle(new Error('boom'))).not.toThrow();
    expect(calls).toEqual(['report', 'exit:1']);
  });
});

describe('createSuspendHandler', () => {
  it('saves terminal modes before re-raising the default stop disposition', () => {
    const calls: string[] = [];
    const save = vi.fn(() => calls.push('save'));
    const raiseDefault = vi.fn(() => calls.push('raise-default'));

    const handle = createSuspendHandler({ save, raiseDefault });
    handle();

    expect(calls).toEqual(['save', 'raise-default']);
  });
});

describe('createResumeHandler', () => {
  it('restores terminal modes on resume', () => {
    const calls: string[] = [];
    const restore = vi.fn(() => calls.push('restore'));

    const handle = createResumeHandler({ restore });
    handle();

    expect(calls).toEqual(['restore']);
  });
});

describe('createSuspendListenerToggle', () => {
  it('installs once and ignores a redundant install', () => {
    const calls: string[] = [];
    const toggle = createSuspendListenerToggle({
      install: () => calls.push('install'),
      uninstall: () => calls.push('uninstall'),
    });

    toggle.install();
    toggle.install();

    expect(calls).toEqual(['install']);
  });

  it('balances a normal suspend/resume cycle', () => {
    const calls: string[] = [];
    const toggle = createSuspendListenerToggle({
      install: () => calls.push('install'),
      uninstall: () => calls.push('uninstall'),
    });

    toggle.install();
    toggle.uninstall();
    toggle.install();

    expect(calls).toEqual(['install', 'uninstall', 'install']);
  });

  it('ignores a spurious resume so no duplicate listener is stacked', () => {
    const calls: string[] = [];
    const toggle = createSuspendListenerToggle({
      install: () => calls.push('install'),
      uninstall: () => calls.push('uninstall'),
    });

    toggle.install();
    toggle.install();
    toggle.uninstall();

    expect(calls).toEqual(['install', 'uninstall']);
  });

  it('ignores uninstall when nothing is installed', () => {
    const calls: string[] = [];
    const toggle = createSuspendListenerToggle({
      install: () => calls.push('install'),
      uninstall: () => calls.push('uninstall'),
    });

    toggle.uninstall();

    expect(calls).toEqual([]);
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

  it('skips terminal-restore writes when stdout is gone', () => {
    const written: string[] = [];
    process.stdout.write = ((chunk: string) => {
      written.push(chunk);
      return true;
    }) as typeof process.stdout.write;
    const destroyed = Object.getOwnPropertyDescriptor(process.stdout, 'destroyed');
    Object.defineProperty(process.stdout, 'destroyed', { value: true, configurable: true });

    try {
      restoreTerminal({ fullscreen: true, mouse: true });
    } finally {
      if (destroyed) Object.defineProperty(process.stdout, 'destroyed', destroyed);
    }

    expect(written).toEqual([]);
  });
});
