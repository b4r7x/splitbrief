import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createCrashHandler,
  createResumeHandler,
  createSuspendHandler,
  createSuspendListenerToggle,
  createTerminationHandler,
  createTuiCleanup,
  restoreTerminal,
} from './process-lifecycle.js';
import { terminalSequences } from '../../lib/terminal/control.js';
import { processError } from '../../lib/process/errors.js';

const lifecycleMocks = vi.hoisted(() => ({
  teardownStores: vi.fn<() => void | Promise<void>>(),
  killAllProcesses: vi.fn<() => Promise<void>>(),
  awaitActiveWorkflowShutdown: vi.fn<() => Promise<void>>(),
  flushOtel: vi.fn<() => Promise<void>>(),
}));

vi.mock('../init-stores.js', () => ({ teardownStores: lifecycleMocks.teardownStores }));
vi.mock('../../lib/process/registry.js', () => ({
  killAllProcesses: lifecycleMocks.killAllProcesses,
}));
vi.mock('../../engine/orchestrator/session-lifecycle/shutdown.js', () => ({
  awaitActiveWorkflowShutdown: lifecycleMocks.awaitActiveWorkflowShutdown,
}));
vi.mock('../../lib/otel.js', () => ({ flushOtel: lifecycleMocks.flushOtel }));

describe('TUI cleanup', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    lifecycleMocks.killAllProcesses.mockResolvedValue(undefined);
    lifecycleMocks.awaitActiveWorkflowShutdown.mockResolvedValue(undefined);
    lifecycleMocks.flushOtel.mockResolvedValue(undefined);
  });

  it('awaits every cleanup owner in order', async () => {
    const calls: string[] = [];
    lifecycleMocks.teardownStores.mockImplementation(() => {
      calls.push('stores');
    });
    lifecycleMocks.killAllProcesses.mockImplementation(async () => {
      calls.push('processes');
    });
    lifecycleMocks.awaitActiveWorkflowShutdown.mockImplementation(async () => {
      calls.push('workflow');
    });
    lifecycleMocks.flushOtel.mockImplementation(async () => {
      calls.push('telemetry');
    });
    const cleanup = createTuiCleanup({
      restore: async () => {
        calls.push('terminal');
      },
    });

    await cleanup();

    expect(calls).toEqual(['stores', 'processes', 'workflow', 'terminal', 'telemetry']);
  });

  it('deduplicates concurrent cleanup with the same promise', async () => {
    let releaseProcesses = () => {};
    lifecycleMocks.killAllProcesses.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          releaseProcesses = resolve;
        }),
    );
    const restore = vi.fn();
    const cleanup = createTuiCleanup({ restore });

    const first = cleanup();
    const concurrent = cleanup();

    expect(concurrent).toBe(first);
    await vi.waitFor(() => expect(lifecycleMocks.killAllProcesses).toHaveBeenCalledTimes(1));
    releaseProcesses();
    await first;
    expect(restore).toHaveBeenCalledTimes(1);
  });

  it('continues cleanup when an earlier owner fails', async () => {
    lifecycleMocks.teardownStores.mockImplementation(() => {
      throw new Error('store teardown failed');
    });
    const restore = vi.fn();

    await expect(createTuiCleanup({ restore })()).resolves.toBeUndefined();

    expect(lifecycleMocks.killAllProcesses).toHaveBeenCalledOnce();
    expect(lifecycleMocks.awaitActiveWorkflowShutdown).toHaveBeenCalledOnce();
    expect(restore).toHaveBeenCalledOnce();
    expect(lifecycleMocks.flushOtel).toHaveBeenCalledOnce();
  });

  it('reports a live process group after running every later cleanup owner', async () => {
    const limitation = processError.platformLimitation({
      operation: 'verify-absence',
      target: 'process-group',
      signal: 'SIGKILL',
    });
    lifecycleMocks.killAllProcesses.mockRejectedValue(limitation);
    const restore = vi.fn();

    await expect(createTuiCleanup({ restore })()).rejects.toBe(limitation);

    expect(lifecycleMocks.awaitActiveWorkflowShutdown).toHaveBeenCalledOnce();
    expect(restore).toHaveBeenCalledOnce();
    expect(lifecycleMocks.flushOtel).toHaveBeenCalledOnce();
  });

  it('restores the terminal and exits when a process group cannot be reaped', async () => {
    const limitation = processError.platformLimitation({
      operation: 'verify-absence',
      target: 'process-group',
      signal: 'SIGKILL',
    });
    lifecycleMocks.killAllProcesses.mockRejectedValue(limitation);
    const restore = vi.fn();
    const exit = vi.fn();
    const reportCleanupFailure = vi.fn();
    const handle = createTerminationHandler({
      cleanup: createTuiCleanup({ restore }),
      reportCleanupFailure,
      exit,
    });

    await handle('SIGTERM');

    expect(restore).toHaveBeenCalledOnce();
    expect(lifecycleMocks.flushOtel).toHaveBeenCalledOnce();
    expect(reportCleanupFailure).toHaveBeenCalledWith(limitation);
    expect(exit).toHaveBeenCalledWith(143);
  });
});

describe('termination handler', () => {
  it('cleans up then exits with the conventional code for SIGINT', async () => {
    const calls: string[] = [];
    const cleanup = vi.fn(async () => {
      calls.push('cleanup');
    });
    const exit = vi.fn((code: number) => calls.push(`exit:${code}`));
    const reportCleanupFailure = vi.fn();

    const handle = createTerminationHandler({ cleanup, reportCleanupFailure, exit });
    await handle('SIGINT');

    expect(calls).toEqual(['cleanup', 'exit:130']);
    expect(reportCleanupFailure).not.toHaveBeenCalled();
  });

  it('exits with 143 for SIGTERM', async () => {
    const cleanup = vi.fn(async () => {});
    const exit = vi.fn();

    const handle = createTerminationHandler({ cleanup, reportCleanupFailure: vi.fn(), exit });
    await handle('SIGTERM');

    expect(exit).toHaveBeenCalledWith(143);
  });

  it('cleans up then exits with 129 for SIGHUP', async () => {
    const calls: string[] = [];
    const cleanup = vi.fn(async () => {
      calls.push('cleanup');
    });
    const exit = vi.fn((code: number) => calls.push(`exit:${code}`));

    const handle = createTerminationHandler({ cleanup, reportCleanupFailure: vi.fn(), exit });
    await handle('SIGHUP');

    expect(calls).toEqual(['cleanup', 'exit:129']);
  });

  it('returns one promise when signals fire repeatedly', async () => {
    const cleanup = vi.fn(async () => {});
    const exit = vi.fn();

    const handle = createTerminationHandler({ cleanup, reportCleanupFailure: vi.fn(), exit });
    const first = handle('SIGINT');
    const repeated = handle('SIGINT');
    const competing = handle('SIGTERM');

    expect(repeated).toBe(first);
    expect(competing).toBe(first);
    await first;
    expect(cleanup).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledTimes(1);
  });

  it('reports cleanup failure and still exits', async () => {
    const limitation = processError.platformLimitation({
      operation: 'verify-absence',
      target: 'process-group',
      signal: 'SIGKILL',
    });
    const calls: string[] = [];
    const cleanup = vi.fn(async () => {
      throw limitation;
    });
    const reportCleanupFailure = vi.fn((error: unknown) => calls.push(`report:${String(error)}`));
    const exit = vi.fn((code: number) => calls.push(`exit:${code}`));

    const handle = createTerminationHandler({ cleanup, reportCleanupFailure, exit });

    await expect(handle('SIGINT')).resolves.toBeUndefined();
    expect(reportCleanupFailure).toHaveBeenCalledWith(limitation);
    expect(calls[calls.length - 1]).toBe('exit:130');
  });

  it('exits even when the cleanup-failure report throws', async () => {
    const cleanup = vi.fn(async () => {
      throw new Error('unreaped group');
    });
    const reportCleanupFailure = vi.fn(() => {
      throw new Error('stderr gone');
    });
    const exit = vi.fn();

    const handle = createTerminationHandler({ cleanup, reportCleanupFailure, exit });

    await expect(handle('SIGINT')).rejects.toThrow('stderr gone');
    expect(exit).toHaveBeenCalledWith(130);
  });
});

describe('crash handler', () => {
  it('restores the terminal before reporting, then exits non-zero', async () => {
    const calls: string[] = [];
    const cleanup = vi.fn(async () => {
      calls.push('cleanup');
    });
    const report = vi.fn((reason: unknown) => calls.push(`report:${String(reason)}`));
    const exit = vi.fn((code: number) => calls.push(`exit:${code}`));

    const handle = createCrashHandler({
      cleanup,
      report,
      reportCleanupFailure: vi.fn(),
      exit,
    });
    await handle(new Error('boom'));

    expect(calls).toEqual(['cleanup', 'report:Error: boom', 'exit:1']);
  });

  it('returns one promise when multiple crashes fire', async () => {
    const cleanup = vi.fn(async () => {});
    const report = vi.fn();
    const exit = vi.fn();

    const handle = createCrashHandler({
      cleanup,
      report,
      reportCleanupFailure: vi.fn(),
      exit,
    });
    const first = handle(new Error('first'));
    const repeated = handle(new Error('second'));

    expect(repeated).toBe(first);
    await first;
    expect(cleanup).toHaveBeenCalledTimes(1);
    expect(report).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledTimes(1);
  });

  it('reports cleanup failure, still prints the crash, and exits', async () => {
    const limitation = processError.platformLimitation({
      operation: 'verify-absence',
      target: 'process-group',
      signal: 'SIGKILL',
    });
    const calls: string[] = [];
    const cleanup = vi.fn(async () => {
      throw limitation;
    });
    const report = vi.fn((reason: unknown) => calls.push(`report:${String(reason)}`));
    const reportCleanupFailure = vi.fn((error: unknown) =>
      calls.push(`cleanup-failure:${String(error)}`),
    );
    const exit = vi.fn((code: number) => calls.push(`exit:${code}`));

    const handle = createCrashHandler({ cleanup, report, reportCleanupFailure, exit });

    await expect(handle(new Error('boom'))).resolves.toBeUndefined();
    expect(reportCleanupFailure).toHaveBeenCalledWith(limitation);
    expect(calls).toEqual([
      `cleanup-failure:${String(limitation)}`,
      'report:Error: boom',
      'exit:1',
    ]);
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
      terminalSequences.disableButtonEventMouse,
      terminalSequences.disableAnyMotionMouse,
      terminalSequences.disableSgrMouse,
      terminalSequences.disableBracketedPaste,
      terminalSequences.exitAltBuffer,
      terminalSequences.showCursor,
    ]);
  });

  it('can disable paste mode without disabling mouse tracking', () => {
    const written: string[] = [];
    process.stdout.write = ((chunk: string) => {
      written.push(chunk);
      return true;
    }) as typeof process.stdout.write;

    restoreTerminal({ fullscreen: true, mouse: false, paste: true });

    expect(written).toEqual([
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
