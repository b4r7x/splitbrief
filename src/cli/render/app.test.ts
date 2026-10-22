import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PassThrough } from 'node:stream';
import { createElement, Fragment } from 'react';
import { withFullScreen } from 'fullscreen-ink';
import { render } from 'ink';
import { terminalBackgroundStore } from '../../stores/ui/terminal-background.js';
import { processError } from '../../lib/process/errors.js';
import { terminalSequences } from '../../lib/terminal/control.js';
import {
  resumeTerminalAfterEditor,
  suspendTerminalForEditor,
} from '../../lib/terminal/editor-handover.js';
import { createCrashHandler, createTerminationHandler } from './process-lifecycle.js';
import { createCrashListener, createTerminationSignalListener, renderApp } from './app.js';

const lifecycle = vi.hoisted(() => ({
  teardownStores: vi.fn<() => void | Promise<void>>(),
  shutdownDetection: vi.fn<() => Promise<void>>(),
  killAllProcesses: vi.fn<() => Promise<void>>(),
  awaitActiveWorkflowShutdown: vi.fn<() => Promise<void>>(),
}));

vi.mock('../bootstrap/init.js', () => ({ teardownStores: lifecycle.teardownStores }));
vi.mock('../../engine/detection/service.js', () => ({
  getDefaultDetectionService: () => ({ shutdown: lifecycle.shutdownDetection }),
}));
vi.mock('../../lib/process/registry.js', () => ({ killAllProcesses: lifecycle.killAllProcesses }));
vi.mock('../../engine/orchestrator/session-lifecycle/shutdown.js', () => ({
  awaitActiveWorkflowShutdown: lifecycle.awaitActiveWorkflowShutdown,
}));

vi.mock('ink', async (importOriginal) => {
  const actual = await importOriginal<typeof import('ink')>();
  return {
    ...actual,
    render: vi.fn(),
  };
});

vi.mock('fullscreen-ink', () => ({
  withFullScreen: vi.fn(),
}));

function inkInstance(
  waitUntilExit: () => Promise<void> = async () => {},
  unmount: () => void = () => {},
) {
  return { waitUntilExit, unmount, rerender: () => {}, cleanup: () => {}, clear: () => {} };
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(render).mockReturnValue(inkInstance());
  vi.mocked(withFullScreen).mockReturnValue({
    start: async () => {},
    waitUntilExit: async () => {},
    instance: inkInstance(),
  });
  lifecycle.teardownStores.mockResolvedValue(undefined);
  lifecycle.shutdownDetection.mockResolvedValue(undefined);
  lifecycle.killAllProcesses.mockResolvedValue(undefined);
  lifecycle.awaitActiveWorkflowShutdown.mockResolvedValue(undefined);
});

describe('renderApp background detection', () => {
  it.each([
    { inputTTY: true, outputTTY: true, fullscreen: true, probe: true },
    { inputTTY: false, outputTTY: true, fullscreen: true, probe: false },
    { inputTTY: true, outputTTY: false, fullscreen: true, probe: false },
    { inputTTY: true, outputTTY: true, fullscreen: false, probe: false },
  ])('probes only a fullscreen TTY: %j', async ({ inputTTY, outputTTY, fullscreen, probe }) => {
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
      await renderApp(createElement(Fragment), { fullscreen, mouse: false }, { exit: vi.fn() });

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

describe('renderApp key input', () => {
  it.each(['fullscreen', 'inline', 'fallback'] as const)(
    'hands Ink one key per backspace byte on the %s path',
    async (path) => {
      const input = Object.assign(new PassThrough(), {
        isTTY: false,
        isRaw: false,
        setRawMode: () => input,
        ref: () => input,
        unref: () => input,
      });
      vi.spyOn(process, 'stdin', 'get').mockReturnValue(input as unknown as typeof process.stdin);
      const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
      const inkExit = Promise.withResolvers<void>();
      let inkStdin: NodeJS.ReadStream | undefined;
      vi.mocked(render).mockImplementationOnce((_node, options) => {
        if (options !== undefined && 'stdin' in options) inkStdin = options.stdin;
        return inkInstance(() => inkExit.promise);
      });
      vi.mocked(withFullScreen).mockImplementationOnce((_node, options) => {
        if (path === 'fullscreen' && options !== undefined && 'stdin' in options) {
          inkStdin = options.stdin;
        }
        return {
          start: () =>
            path === 'fallback'
              ? Promise.reject(new Error('fullscreen unavailable'))
              : Promise.resolve(),
          waitUntilExit: () => inkExit.promise,
          instance: inkInstance(() => inkExit.promise),
        };
      });
      const rendering = renderApp(
        createElement(Fragment),
        { fullscreen: path !== 'inline', mouse: false },
        { exit: vi.fn() },
      );
      try {
        const stdin = await vi.waitFor(() => {
          if (inkStdin === undefined) throw new Error('Ink has no stdin');
          return inkStdin;
        });
        expect(stdin).not.toBe(input);
        const reads: string[] = [];
        stdin.setEncoding('utf8');
        stdin.on('readable', () => {
          for (let read = stdin.read(); read !== null; read = stdin.read()) reads.push(read);
        });
        input.write('ab\x7f\x7f');
        await vi.waitFor(() => expect(reads).toEqual(['ab', '\b', '\b']));
      } finally {
        inkExit.resolve();
        await rendering;
        stdout.mockRestore();
        vi.restoreAllMocks();
        input.destroy();
      }
    },
  );
});

describe('renderApp completion', () => {
  it.each(['fullscreen', 'inline', 'fallback'] as const)(
    'exits once after all cleanup barriers on the %s path',
    async (path) => {
      const inkExit = Promise.withResolvers<void>();
      const barriers = Array.from({ length: 4 }, () => Promise.withResolvers<void>());
      const owners = [
        lifecycle.teardownStores,
        lifecycle.shutdownDetection,
        lifecycle.killAllProcesses,
        lifecycle.awaitActiveWorkflowShutdown,
      ];
      owners.forEach((owner, index) => {
        const barrier = barriers[index];
        if (barrier === undefined) throw new Error('Missing cleanup barrier');
        owner.mockImplementation(() => barrier.promise);
      });
      vi.mocked(render).mockReturnValueOnce(
        inkInstance(
          () => inkExit.promise,
          () => inkExit.resolve(),
        ),
      );
      vi.mocked(withFullScreen).mockImplementationOnce(() => ({
        start: () =>
          path === 'fallback'
            ? Promise.reject(new Error('fullscreen unavailable'))
            : Promise.resolve(),
        waitUntilExit: () => inkExit.promise,
        instance: inkInstance(
          () => inkExit.promise,
          () => inkExit.resolve(),
        ),
      }));
      const writes: string[] = [];
      const stdout = vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
        writes.push(String(chunk));
        return true;
      });
      const exit = vi.fn(() => {
        if (path !== 'inline') expect(writes).toContain('\x1b[?1049l');
      });
      const rendering = renderApp(
        createElement(Fragment),
        { fullscreen: path !== 'inline', unmountSignal: new AbortController().signal },
        { exit },
      );
      try {
        expect(exit).not.toHaveBeenCalled();
        inkExit.resolve();
        for (const [index, owner] of owners.entries()) {
          await vi.waitFor(() => expect(owner).toHaveBeenCalledOnce());
          expect(exit).not.toHaveBeenCalled();
          barriers[index]?.resolve();
        }
        await rendering;
        expect(exit).toHaveBeenCalledExactlyOnceWith(0);
      } finally {
        inkExit.resolve();
        barriers.forEach((barrier) => {
          barrier.resolve();
        });
        await rendering;
        stdout.mockRestore();
      }
    },
  );

  it.each([true, false])(
    'returns control after a handoff unmount, fullscreen=%s',
    async (fullscreen) => {
      const unmount = new AbortController();
      const inkExit = Promise.withResolvers<void>();
      const instance = inkInstance(
        () => inkExit.promise,
        () => inkExit.resolve(),
      );
      vi.mocked(render).mockReturnValueOnce(instance);
      vi.mocked(withFullScreen).mockReturnValueOnce({
        start: async () => {},
        waitUntilExit: instance.waitUntilExit,
        instance,
      });
      const exit = vi.fn();
      const rendering = renderApp(
        createElement(Fragment),
        {
          fullscreen,
          unmountSignal: unmount.signal,
        },
        { exit },
      );
      unmount.abort();
      await rendering;
      expect(lifecycle.awaitActiveWorkflowShutdown).toHaveBeenCalledOnce();
      expect(exit).not.toHaveBeenCalled();
    },
  );

  it.each(['render', 'cleanup'] as const)(
    'propagates a %s failure without exiting',
    async (failure) => {
      const error = new Error(`${failure} failed`);
      vi.mocked(render).mockReturnValueOnce(
        inkInstance(async () => {
          if (failure === 'render') throw error;
        }),
      );
      if (failure === 'cleanup') lifecycle.killAllProcesses.mockRejectedValueOnce(error);
      const exit = vi.fn();
      await expect(
        renderApp(createElement(Fragment), { fullscreen: false }, { exit }),
      ).rejects.toBe(error);
      expect(exit).not.toHaveBeenCalled();
    },
  );

  it('uses the selected process exit code', async () => {
    const previous = process.exitCode;
    const exit = vi.fn();
    process.exitCode = 7;
    try {
      await renderApp(createElement(Fragment), { fullscreen: false }, { exit });
      expect(exit).toHaveBeenCalledExactlyOnceWith(7);
    } finally {
      process.exitCode = previous;
    }
  });

  it('exits once with the signal code when termination races Ink completion', async () => {
    const inkExit = Promise.withResolvers<void>();
    const workflow = Promise.withResolvers<void>();
    lifecycle.awaitActiveWorkflowShutdown.mockImplementation(() => workflow.promise);
    vi.mocked(render).mockReturnValueOnce(
      inkInstance(
        () => inkExit.promise,
        () => inkExit.resolve(),
      ),
    );
    const exit = vi.fn();
    const rendering = renderApp(createElement(Fragment), { fullscreen: false }, { exit });
    process.emit('SIGTERM', 'SIGTERM');
    inkExit.resolve();
    await vi.waitFor(() => expect(lifecycle.awaitActiveWorkflowShutdown).toHaveBeenCalledOnce());
    expect(exit).not.toHaveBeenCalled();
    workflow.resolve();
    await rendering;
    expect(exit).toHaveBeenCalledExactlyOnceWith(143);
  });

  // Ink unmounts on process exit and paints a final frame; a frame as tall as the terminal
  // is written as a clear of the screen and the scrollback.
  it.each([
    ['a termination signal', true],
    ['a termination signal', false],
    ['a crash', true],
    ['a crash', false],
  ] as const)(
    'paints nothing after the terminal is restored on %s, fullscreen=%s',
    async (stop, fullscreen) => {
      const inkExit = Promise.withResolvers<void>();
      let inkStdout: NodeJS.WriteStream | undefined;
      vi.mocked(render).mockImplementationOnce((_node, options) => {
        if (options !== undefined && 'stdout' in options) inkStdout = options.stdout;
        return inkInstance(() => inkExit.promise);
      });
      vi.mocked(withFullScreen).mockImplementationOnce((_node, options) => {
        if (options !== undefined && 'stdout' in options) inkStdout = options.stdout;
        return {
          start: async () => {},
          waitUntilExit: () => inkExit.promise,
          instance: inkInstance(() => inkExit.promise),
        };
      });
      const writes: string[] = [];
      const stdout = vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
        writes.push(String(chunk));
        if (chunk === terminalSequences.exitAltBuffer) inkStdout?.write('frame during restore');
        return true;
      });
      const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
      const exit = vi.fn(() => {
        inkStdout?.write('final frame');
        inkStdout?.write(terminalSequences.popKittyKeyboard);
      });
      const known = new Set(process.listeners('uncaughtException'));
      const rendering = renderApp(createElement(Fragment), { fullscreen }, { exit });
      try {
        await vi.waitFor(() => expect(inkStdout).toBeDefined());
        inkStdout?.write('live frame');
        if (stop === 'a crash') {
          const crash = process
            .listeners('uncaughtException')
            .find((listener) => !known.has(listener));
          crash?.(new Error('boom'), 'uncaughtException');
        } else {
          process.emit('SIGTERM', 'SIGTERM');
        }
        await vi.waitFor(() => expect(exit).toHaveBeenCalledOnce());
        expect(writes).toContain('live frame');
        expect(writes).not.toContain('frame during restore');
        expect(writes).not.toContain('final frame');
        expect(writes.at(-1)).toBe(terminalSequences.popKittyKeyboard);
        if (fullscreen) expect(writes).toContain(terminalSequences.exitAltBuffer);
      } finally {
        inkExit.resolve();
        await rendering;
        stdout.mockRestore();
        stderr.mockRestore();
      }
    },
  );
  // Cleanup restores the terminal whatever fails; only a tool process it cannot stop reaches the report.
  it.each([
    ['a termination signal', 'Could not stop every tool process while SPLITBRIEF stopped'],
    ['a crash', 'Could not stop every tool process after the crash'],
  ] as const)('says a tool process may keep running after %s', async (stop, words) => {
    const inkExit = Promise.withResolvers<void>();
    vi.mocked(render).mockReturnValueOnce(inkInstance(() => inkExit.promise));
    lifecycle.killAllProcesses.mockRejectedValueOnce(new Error('the process group is still live'));
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const exit = vi.fn();
    const known = new Set(process.listeners('uncaughtException'));
    const rendering = renderApp(createElement(Fragment), { fullscreen: false }, { exit });
    try {
      if (stop === 'a crash') {
        const crash = process
          .listeners('uncaughtException')
          .find((listener) => !known.has(listener));
        crash?.(new Error('boom'), 'uncaughtException');
      } else {
        process.emit('SIGTERM', 'SIGTERM');
      }
      await vi.waitFor(() => expect(exit).toHaveBeenCalledOnce());
      expect(stderr.mock.calls.map(([chunk]) => String(chunk))).toContain(
        `${words}, so one may keep running: the process group is still live\n`,
      );
    } finally {
      inkExit.resolve();
      await expect(rendering).rejects.toThrow('the process group is still live');
      stderr.mockRestore();
    }
  });
  it.each([true, false])(
    'leaves the keyboard mode off when it crashes while an editor holds the terminal, fullscreen=%s',
    async (fullscreen) => {
      const inkExit = Promise.withResolvers<void>();
      let inkStdout: NodeJS.WriteStream | undefined;
      vi.mocked(render).mockImplementationOnce((_node, options) => {
        if (options !== undefined && 'stdout' in options) inkStdout = options.stdout;
        return inkInstance(() => inkExit.promise);
      });
      vi.mocked(withFullScreen).mockImplementationOnce((_node, options) => {
        if (options !== undefined && 'stdout' in options) inkStdout = options.stdout;
        return {
          start: async () => {},
          waitUntilExit: () => inkExit.promise,
          instance: inkInstance(() => inkExit.promise),
        };
      });
      const writes: string[] = [];
      const stdout = vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
        writes.push(String(chunk));
        return true;
      });
      const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
      const exit = vi.fn(() => {
        inkStdout?.write(terminalSequences.popKittyKeyboard);
      });
      const known = new Set(process.listeners('uncaughtException'));
      const rendering = renderApp(createElement(Fragment), { fullscreen }, { exit });
      try {
        await vi.waitFor(() => expect(inkStdout).toBeDefined());
        inkStdout?.write('\u001b[>1u');
        suspendTerminalForEditor();
        const crash = process
          .listeners('uncaughtException')
          .find((listener) => !known.has(listener));
        crash?.(new Error('boom'), 'uncaughtException');
        await vi.waitFor(() => expect(exit).toHaveBeenCalledOnce());
        expect(writes.filter((chunk) => chunk === terminalSequences.popKittyKeyboard)).toHaveLength(
          1,
        );
      } finally {
        resumeTerminalAfterEditor();
        inkExit.resolve();
        await rendering;
        stdout.mockRestore();
        stderr.mockRestore();
      }
    },
  );
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
