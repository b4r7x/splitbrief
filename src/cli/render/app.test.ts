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
        exit: signalExit,
      }),
      reportCleanupFailure,
    });
    const crashListener = createCrashListener({
      handle: createCrashHandler({
        cleanup: async () => {},
        report: reportCrash,
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

  it('reports rejected cleanup without restoring exit behavior or leaking a rejection', async () => {
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
          exit: signalExit,
        }),
        reportCleanupFailure: reportSignalCleanupFailure,
      });
      const crashReason = new Error('boom');
      const crashListener = createCrashListener({
        handle: createCrashHandler({
          cleanup: () => Promise.reject(limitation),
          report: reportCrash,
          exit: crashExit,
        }),
        reportCrash,
        reportCleanupFailure: reportCrashCleanupFailure,
      });

      signalListener('SIGTERM');
      crashListener(crashReason);

      await vi.waitFor(() => {
        expect(reportSignalCleanupFailure).toHaveBeenCalledWith(limitation);
        expect(reportCrashCleanupFailure).toHaveBeenCalledWith(limitation);
      });
      await new Promise<void>((resolve) => setImmediate(resolve));

      expect(signalExit).not.toHaveBeenCalled();
      expect(crashExit).not.toHaveBeenCalled();
      expect(reportCrash).toHaveBeenCalledWith(crashReason);
      expect(unhandledRejection).not.toHaveBeenCalled();
    } finally {
      process.off('unhandledRejection', unhandledRejection);
    }
  });
});
