import { describe, expect, it, vi } from 'vitest';
import { PassThrough } from 'node:stream';
import { createElement, Fragment } from 'react';
import { withFullScreen } from 'fullscreen-ink';
import { terminalBackgroundStore } from '../../stores/ui/terminal-background.js';
import { processError } from '../../lib/process/errors.js';
import { createCrashHandler, createTerminationHandler } from './process-lifecycle.js';
import { createCrashListener, createTerminationSignalListener, renderApp } from './app.js';

vi.mock('ink', async (importOriginal) => {
  const actual = await importOriginal<typeof import('ink')>();
  return {
    ...actual,
    render: vi.fn(() => ({ waitUntilExit: () => Promise.resolve() })),
  };
});

vi.mock('fullscreen-ink', () => ({
  withFullScreen: vi.fn(() => ({
    start: () => Promise.resolve(),
    waitUntilExit: () => Promise.resolve(),
    instance: { unmount: () => {} },
  })),
}));

describe('renderApp background detection', () => {
  it.each([
    { inputTTY: true, outputTTY: true, fullscreen: true, probe: true },
    { inputTTY: false, outputTTY: true, fullscreen: true, probe: false },
    { inputTTY: true, outputTTY: false, fullscreen: true, probe: false },
    { inputTTY: true, outputTTY: true, fullscreen: false, probe: false },
  ])('probes only a filtered TTY: %j', async ({ inputTTY, outputTTY, fullscreen, probe }) => {
    const input = new PassThrough();
    Object.assign(input, {
      isTTY: inputTTY,
      fd: 0,
      isRaw: false,
      setRawMode: (mode: boolean) => {
        Object.assign(input, { isRaw: mode });
        return input;
      },
    });
    const output = Object.assign(new PassThrough(), {
      isTTY: outputTTY,
      fd: 1,
      columns: 100,
      rows: 24,
    });
    const writes: string[] = [];
    output.on('data', (chunk: Buffer) => {
      const text = chunk.toString();
      writes.push(text);
      if (text === '\u001b[c') input.write('\u001b]11;rgb:24/27/3a\u0007\u001b[?62c');
    });
    vi.spyOn(process, 'stdin', 'get').mockReturnValue(input as unknown as typeof process.stdin);
    vi.spyOn(process, 'stdout', 'get').mockReturnValue(output as unknown as typeof process.stdout);
    vi.mocked(withFullScreen).mockClear();
    terminalBackgroundStore.reset();
    try {
      await renderApp(createElement(Fragment), { fullscreen, mouse: false });

      expect(writes.includes('\u001b]11;?\u001b\\')).toBe(probe);
      expect(terminalBackgroundStore.get()).toBe(probe ? '#24273a' : undefined);
      if (fullscreen) {
        const options = vi.mocked(withFullScreen).mock.calls[0]?.[1];
        if (options === undefined || !('stdin' in options))
          throw new Error('Missing filtered stdin');
        expect(options.stdin).toBeDefined();
        expect(options.stdin).not.toBe(input);
      }
    } finally {
      vi.restoreAllMocks();
      terminalBackgroundStore.reset();
      input.destroy();
      output.destroy();
    }
  });
});

describe('app process listeners', () => {
  it('preserves the normal signal and crash exits after successful cleanup', async () => {
    const signalExit = vi.fn();
    const crashExit = vi.fn();
    const reportCrash = vi.fn();
    const reportCleanupFailure = vi.fn();
    const signalListener = createTerminationSignalListener({
      handle: createTerminationHandler({
        cleanup: async () => {},
        reportCleanupFailure,
        exit: signalExit,
      }),
      reportCleanupFailure,
    });
    const crashListener = createCrashListener({
      handle: createCrashHandler({
        cleanup: async () => {},
        report: reportCrash,
        reportCleanupFailure,
        exit: crashExit,
      }),
      reportCrash,
      reportCleanupFailure,
    });

    signalListener('SIGTERM');
    crashListener(new Error('boom'));

    await vi.waitFor(() => {
      expect(signalExit).toHaveBeenCalledWith(143);
      expect(crashExit).toHaveBeenCalledWith(1);
    });
    expect(reportCrash).toHaveBeenCalledOnce();
    expect(reportCleanupFailure).not.toHaveBeenCalled();
  });

  it('reports rejected cleanup, still exits, and leaks no rejection', async () => {
    const limitation = processError.platformLimitation({
      operation: 'verify-absence',
      target: 'process-group',
      signal: 'SIGKILL',
    });
    const signalExit = vi.fn();
    const crashExit = vi.fn();
    const reportCrash = vi.fn();
    const reportSignalCleanupFailure = vi.fn();
    const reportCrashCleanupFailure = vi.fn();
    const unhandledRejection = vi.fn();
    process.on('unhandledRejection', unhandledRejection);

    try {
      const signalListener = createTerminationSignalListener({
        handle: createTerminationHandler({
          cleanup: () => Promise.reject(limitation),
          reportCleanupFailure: reportSignalCleanupFailure,
          exit: signalExit,
        }),
        reportCleanupFailure: reportSignalCleanupFailure,
      });
      const crashReason = new Error('boom');
      const crashListener = createCrashListener({
        handle: createCrashHandler({
          cleanup: () => Promise.reject(limitation),
          report: reportCrash,
          reportCleanupFailure: reportCrashCleanupFailure,
          exit: crashExit,
        }),
        reportCrash,
        reportCleanupFailure: reportCrashCleanupFailure,
      });

      signalListener('SIGTERM');
      crashListener(crashReason);

      await vi.waitFor(() => {
        expect(signalExit).toHaveBeenCalledWith(143);
        expect(crashExit).toHaveBeenCalledWith(1);
      });
      await new Promise<void>((resolve) => setImmediate(resolve));

      expect(reportSignalCleanupFailure).toHaveBeenCalledOnce();
      expect(reportSignalCleanupFailure).toHaveBeenCalledWith(limitation);
      expect(reportCrashCleanupFailure).toHaveBeenCalledOnce();
      expect(reportCrashCleanupFailure).toHaveBeenCalledWith(limitation);
      expect(reportCrash).toHaveBeenCalledOnce();
      expect(reportCrash).toHaveBeenCalledWith(crashReason);
      expect(unhandledRejection).not.toHaveBeenCalled();
    } finally {
      process.off('unhandledRejection', unhandledRejection);
    }
  });
});
