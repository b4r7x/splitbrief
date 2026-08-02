import { describe, expect, it, vi } from 'vitest';
import { processError } from '../../lib/process/errors.js';
import { createCrashHandler, createTerminationHandler } from './process-lifecycle.js';
import { createCrashListener, createTerminationSignalListener } from './app.js';

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
