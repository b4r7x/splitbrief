import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { createElement, Fragment, isValidElement } from 'react';
import { withFullScreen } from 'fullscreen-ink';
import { render } from 'ink';
import { terminalBackgroundStore } from '../../stores/ui/terminal-background.js';
import { terminalSequences } from '../../lib/terminal/control.js';
import {
  resumeTerminalAfterEditor,
  suspendTerminalForEditor,
} from '../../lib/terminal/editor-handover.js';
import { getActiveFilteredStdin } from '../../lib/terminal/filtered-stdin/active.js';
import { warnError, warnStderr } from '../../lib/warn.js';
import type { FilteredStdin } from '../../lib/terminal/filtered-stdin/types.js';
import { renderApp } from './app.js';
import { InputTurns } from './input-turns.js';
import { __testResetProbeActivity, trackProbe } from '../../engine/probe-activity.js';
import { watchSlowProbeLines } from '../slow-probe-line.js';

const lifecycle = vi.hoisted(() => ({
  teardownStores: vi.fn<() => void | Promise<void>>(),
  shutdownDetection: vi.fn<() => Promise<void>>(),
  killAllProcesses: vi.fn<() => Promise<void>>(),
  awaitActiveWorkflowShutdown: vi.fn<() => Promise<void>>(),
}));

vi.mock('../bootstrap/init.js', () => ({ teardownStores: lifecycle.teardownStores }));
vi.mock('../../engine/detection/service/create.js', () => ({
  getDefaultDetectionService: () => ({ shutdown: lifecycle.shutdownDetection }),
}));
vi.mock('../../engine/runners/cli-tools/probe/stage.js', () => ({
  stopToolStages: vi.fn(),
  awaitToolStages: vi.fn(async () => {}),
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

const PROCESS_EVENTS = [
  'SIGINT',
  'SIGTERM',
  'SIGHUP',
  'SIGTSTP',
  'SIGCONT',
  'uncaughtException',
  'unhandledRejection',
] as const;

const TERMINAL_STEPS = new Map<string, string>(
  Object.entries(terminalSequences).map(([name, sequence]) => [sequence, name]),
);

// A TTY stdin and stdout that record the raw mode, each named control sequence and each stderr
// line in one list, and answer the background query. The key debug log is on, so the TUI taps
// the stdin.
function fakeTerminal() {
  vi.stubEnv('SPLITBRIEF_DEBUG_KEYS', '1');
  const steps: string[] = [];
  const input = Object.assign(new PassThrough(), {
    isTTY: true,
    isRaw: false,
    setRawMode: (mode: boolean) => {
      steps.push(`raw ${mode}`);
      input.isRaw = mode;
      return input;
    },
    ref: () => input,
    unref: () => input,
  });
  const write = (chunk: string | Uint8Array) => {
    const text = String(chunk);
    const step = TERMINAL_STEPS.get(text);
    if (step !== undefined) steps.push(step);
    if (text === '\u001b[c') input.write('\u001b]11;rgb:24/27/3a\u0007\u001b[?62c');
    return true;
  };
  const output = Object.assign(new PassThrough(), {
    isTTY: true,
    fd: 1,
    columns: 100,
    rows: 24,
    write,
  });
  vi.spyOn(process, 'stdin', 'get').mockReturnValue(input as unknown as typeof process.stdin);
  vi.spyOn(process, 'stdout', 'get').mockReturnValue(output as unknown as typeof process.stdout);
  vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
    steps.push(`stderr ${String(chunk).trimEnd()}`);
    return true;
  });
  const base = PROCESS_EVENTS.map((event) => process.listenerCount(event));
  const listenerCounts = () => PROCESS_EVENTS.map((event) => process.listenerCount(event));
  return {
    steps,
    input,
    output,
    listening: () => listenerCounts().every((count, index) => count === (base[index] ?? 0) + 1),
    released: () => listenerCounts().every((count, index) => count === base[index]),
    selecting: () => output.write !== write || output.listenerCount('resize') > 0,
  };
}

function crashListener(known: Set<NodeJS.UncaughtExceptionListener>) {
  return process.listeners('uncaughtException').find((listener) => !known.has(listener));
}

function ended(stream: NodeJS.ReadStream | undefined): boolean {
  return stream !== undefined && 'writableEnded' in stream && stream.writableEnded === true;
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

describe('renderApp input turns', () => {
  function turnsOf(node: unknown): {
    holdInput: (hold: (release: () => void) => void) => () => void;
  } {
    const children = isValidElement<{ children?: unknown }>(node) ? node.props.children : undefined;
    const turns = (Array.isArray(children) ? children : [children]).find(
      (child) => isValidElement(child) && child.type === InputTurns,
    );
    if (!isValidElement<{ holdInput: FilteredStdin['holdInput'] }>(turns)) {
      throw new Error('the app mounts no input turns');
    }
    return turns.props;
  }

  it.each(['fullscreen', 'inline', 'fallback'] as const)(
    'gives Ink the next key once the app has taken the one before it on the %s path',
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
      const mounted: Array<{ node: unknown; stdin: NodeJS.ReadStream | undefined }> = [];
      vi.mocked(render).mockImplementationOnce((node, options) => {
        mounted.push({
          node,
          stdin: options !== undefined && 'stdin' in options ? options.stdin : undefined,
        });
        return inkInstance(() => inkExit.promise);
      });
      vi.mocked(withFullScreen).mockImplementationOnce((node, options) => {
        if (path === 'fullscreen') {
          mounted.push({
            node,
            stdin: options !== undefined && 'stdin' in options ? options.stdin : undefined,
          });
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
        const ink = await vi.waitFor(() => {
          const last = mounted.at(-1);
          if (last?.stdin === undefined) throw new Error('Ink has no stdin');
          return { node: last.node, stdin: last.stdin };
        });
        const releases: Array<() => void> = [];
        turnsOf(ink.node).holdInput((release) => releases.push(release));
        const reads: string[] = [];
        ink.stdin.setEncoding('utf8');
        ink.stdin.on('readable', () => {
          for (let read = ink.stdin.read(); read !== null; read = ink.stdin.read())
            reads.push(read);
        });
        input.write('ab\x7f\x7f');
        await vi.waitFor(() => expect(reads).toEqual(['ab']));
        releases.shift()?.();
        expect(reads).toEqual(['ab', '\b']);
        releases.shift()?.();
        expect(reads).toEqual(['ab', '\b', '\b']);
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

describe('renderApp slow-check line', () => {
  it('drops the line while the app owns the terminal', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    __testResetProbeActivity();
    const inkExit = Promise.withResolvers<void>();
    vi.mocked(render).mockReturnValueOnce(
      inkInstance(
        () => inkExit.promise,
        () => inkExit.resolve(),
      ),
    );
    const lines: string[] = [];
    const stop = watchSlowProbeLines((line) => lines.push(line));
    const probe = Promise.withResolvers<void>();
    let probeRun: Promise<void> | undefined;
    const rendering = renderApp(
      createElement(Fragment),
      { fullscreen: false, unmountSignal: new AbortController().signal },
      { exit: vi.fn() },
    );
    try {
      probeRun = trackProbe({ tool: 'codex', check: 'version' }, () => probe.promise);
      await vi.advanceTimersByTimeAsync(12_000);
      inkExit.resolve();
      await rendering;
      await vi.advanceTimersByTimeAsync(60_000);
      expect(lines).toEqual([]);
    } finally {
      inkExit.resolve();
      await rendering;
      probe.resolve();
      await probeRun;
      stop();
      vi.useRealTimers();
    }
  });

  it('drops the line of a check that comes due while the cleanup runs, and writes the next one after it', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    __testResetProbeActivity();
    const workflow = Promise.withResolvers<void>();
    lifecycle.awaitActiveWorkflowShutdown.mockImplementation(() => workflow.promise);
    const lines: string[] = [];
    const stop = watchSlowProbeLines((line) => lines.push(line));
    const during = Promise.withResolvers<void>();
    const after = Promise.withResolvers<void>();
    const probeRuns: Promise<void>[] = [];
    const rendering = renderApp(
      createElement(Fragment),
      { fullscreen: false, unmountSignal: new AbortController().signal },
      { exit: vi.fn() },
    );
    try {
      await vi.waitFor(() => expect(lifecycle.awaitActiveWorkflowShutdown).toHaveBeenCalledOnce());
      probeRuns.push(trackProbe({ tool: 'codex', check: 'version' }, () => during.promise));
      await vi.advanceTimersByTimeAsync(12_000);
      expect(lines).toEqual([]);
      workflow.resolve();
      await rendering;
      probeRuns.push(trackProbe({ tool: 'opencode', check: 'version' }, () => after.promise));
      await vi.advanceTimersByTimeAsync(12_000);
      expect(lines).toHaveLength(1);
    } finally {
      workflow.resolve();
      await rendering;
      during.resolve();
      after.resolve();
      await Promise.all(probeRuns);
      stop();
      vi.useRealTimers();
    }
  });
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

  it('exits with the signal code when termination arrives during the cleanup after Ink completion', async () => {
    const workflow = Promise.withResolvers<void>();
    lifecycle.awaitActiveWorkflowShutdown.mockImplementation(() => workflow.promise);
    const exit = vi.fn();
    const rendering = renderApp(createElement(Fragment), { fullscreen: false }, { exit });
    await vi.waitFor(() => expect(lifecycle.awaitActiveWorkflowShutdown).toHaveBeenCalledOnce());
    process.emit('SIGTERM', 'SIGTERM');
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

type InkPath = 'fullscreen' | 'inline' | 'fallback';
type Stop = 'an Ink exit' | 'a mount failure' | 'a termination signal' | 'a crash';

function mountInk(path: InkPath, inkExit: PromiseWithResolvers<void>) {
  const ink: { stdout?: NodeJS.WriteStream | undefined } = {};
  vi.mocked(render).mockImplementationOnce((_node, options) => {
    if (options !== undefined && 'stdout' in options) ink.stdout = options.stdout;
    return inkInstance(() => inkExit.promise);
  });
  vi.mocked(withFullScreen).mockImplementationOnce((_node, options) => {
    if (options !== undefined && 'stdout' in options) ink.stdout = options.stdout;
    return {
      start: () =>
        path === 'fallback'
          ? Promise.reject(new Error('fullscreen unavailable'))
          : Promise.resolve(),
      waitUntilExit: () => inkExit.promise,
      instance: inkInstance(() => inkExit.promise),
    };
  });
  return ink;
}

const RESTORE_STEPS: Record<InkPath, string[]> = {
  fullscreen: [
    'disableMouseTracking',
    'disableButtonEventMouse',
    'disableAnyMotionMouse',
    'disableSgrMouse',
    'disableBracketedPaste',
    'exitAltBuffer',
    'showCursor',
    'raw false',
  ],
  inline: ['disableBracketedPaste', 'raw false'],
  fallback: ['disableBracketedPaste', 'exitAltBuffer', 'showCursor', 'raw false'],
};

const END_STEPS: Record<Stop, string[]> = {
  'an Ink exit': ['exit 0'],
  'a mount failure': [],
  'a termination signal': ['exit 143'],
  'a crash': ['stderr SPLITBRIEF crashed: boom', 'exit 1'],
};

describe('renderApp terminal ownership', () => {
  let projectDir: string;

  beforeEach(() => {
    projectDir = mkdtempSync(join(tmpdir(), 'splitbrief-render-'));
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    terminalBackgroundStore.reset();
    rmSync(projectDir, { recursive: true, force: true });
  });

  it('installs the selection, the key tap and the process listeners before the mount, publishes the input before the start, and reads keys after it', async () => {
    const terminal = fakeTerminal();
    const inkExit = Promise.withResolvers<void>();
    let inkStdin: NodeJS.ReadStream | undefined;
    const moments: object[] = [];
    const moment = (at: string) => ({
      at,
      selecting: terminal.selecting(),
      listening: terminal.listening(),
      reads: terminal.input.listenerCount('data'),
      published: inkStdin !== undefined && getActiveFilteredStdin()?.stdin === inkStdin,
      modes: terminal.steps.filter((step) => step.startsWith('enable')),
    });
    vi.mocked(withFullScreen).mockImplementationOnce((_node, options) => {
      if (options !== undefined && 'stdin' in options) inkStdin = options.stdin;
      moments.push(moment('mount'));
      return {
        start: async () => {
          moments.push(moment('start'));
        },
        waitUntilExit: () => {
          moments.push(moment('wait'));
          return inkExit.promise;
        },
        instance: inkInstance(() => inkExit.promise),
      };
    });
    const rendering = renderApp(
      createElement(Fragment),
      { fullscreen: true, projectDir },
      { exit: vi.fn() },
    );
    try {
      await vi.waitFor(() => expect(moments).toHaveLength(3));
      expect(inkStdin).toBeDefined();
      expect(inkStdin).not.toBe(terminal.input);
      expect(moments).toEqual([
        { at: 'mount', selecting: true, listening: true, reads: 1, published: false, modes: [] },
        { at: 'start', selecting: true, listening: true, reads: 1, published: true, modes: [] },
        {
          at: 'wait',
          selecting: true,
          listening: true,
          reads: 2,
          published: true,
          modes: ['enableButtonEventMouse', 'enableSgrMouse', 'enableBracketedPaste'],
        },
      ]);
    } finally {
      inkExit.resolve();
      await rendering;
    }
  });

  it('closes the fullscreen input and drops the selection before it mounts the inline fallback, and reads keys from a new input', async () => {
    const terminal = fakeTerminal();
    const inkExit = Promise.withResolvers<void>();
    const inputs: { fullscreen?: NodeJS.ReadStream; inline?: NodeJS.ReadStream } = {};
    let atInlineMount: object | undefined;
    vi.mocked(withFullScreen).mockImplementationOnce((_node, options) => {
      if (options !== undefined && 'stdin' in options) inputs.fullscreen = options.stdin;
      return {
        start: () => Promise.reject(new Error('fullscreen unavailable')),
        waitUntilExit: () => inkExit.promise,
        instance: inkInstance(() => inkExit.promise),
      };
    });
    vi.mocked(render).mockImplementationOnce((_node, options) => {
      if (options !== undefined && 'stdin' in options) inputs.inline = options.stdin;
      atInlineMount = {
        fullscreenInputEnded: ended(inputs.fullscreen),
        published: getActiveFilteredStdin() !== undefined,
        selecting: terminal.selecting(),
        listening: terminal.listening(),
        reads: terminal.input.listenerCount('data'),
      };
      return inkInstance(() => inkExit.promise);
    });
    const rendering = renderApp(
      createElement(Fragment),
      { fullscreen: true, projectDir },
      { exit: vi.fn() },
    );
    try {
      await vi.waitFor(() => expect(terminal.input.listenerCount('data')).toBe(2));
      expect(atInlineMount).toEqual({
        fullscreenInputEnded: true,
        published: false,
        selecting: false,
        listening: true,
        reads: 1,
      });
      expect(inputs.inline).toBeDefined();
      expect(inputs.inline).not.toBe(inputs.fullscreen);
      expect(ended(inputs.inline)).toBe(false);
    } finally {
      inkExit.resolve();
      await rendering;
    }
    expect(ended(inputs.inline)).toBe(true);
  });

  it.each(
    (['an Ink exit', 'a mount failure', 'a termination signal', 'a crash'] as const).flatMap(
      (stop) =>
        (['fullscreen', 'inline', 'fallback'] as const).map((path) => [stop, path] as const),
    ),
  )('restores each terminal step once and in order after %s on the %s path', async (stop, path) => {
    const terminal = fakeTerminal();
    const inkExit = Promise.withResolvers<void>();
    const ink = mountInk(path, inkExit);
    lifecycle.teardownStores.mockImplementation(() => {
      terminal.steps.push(
        terminal.listening() ? 'listeners on' : 'listeners off',
        'teardown stores',
      );
      warnError('note during teardown', undefined, 'feedback');
    });
    lifecycle.shutdownDetection.mockImplementation(async () => {
      terminal.steps.push('stop detection');
    });
    lifecycle.killAllProcesses.mockImplementation(async () => {
      terminal.steps.push('reap processes');
    });
    lifecycle.awaitActiveWorkflowShutdown.mockImplementation(async () => {
      terminal.steps.push('await the workflow');
    });
    const exit = vi.fn((code: number) => {
      terminal.steps.push(`exit ${code}`);
    });
    const known = new Set(process.listeners('uncaughtException'));
    const settled = renderApp(
      createElement(Fragment),
      { fullscreen: path !== 'inline', projectDir },
      { exit },
    ).then(
      () => 'resolved',
      (error: unknown) => (error instanceof Error ? error.message : 'rejected'),
    );
    let started = 0;
    try {
      await vi.waitFor(() => expect(terminal.input.listenerCount('data')).toBe(2));
      ink.stdout?.write('\u001b[>1u');
      warnStderr('note at exit', 'at-exit');
      started = terminal.steps.length;
      if (stop === 'an Ink exit') inkExit.resolve();
      if (stop === 'a mount failure') inkExit.reject(new Error('mount failed'));
      if (stop === 'a termination signal') process.emit('SIGTERM', 'SIGTERM');
      if (stop === 'a crash') crashListener(known)?.(new Error('boom'), 'uncaughtException');
      await vi.waitFor(() => expect(terminal.steps).toContain('await the workflow'));
      if (stop === 'a termination signal' || stop === 'a crash') {
        await vi.waitFor(() => expect(exit).toHaveBeenCalled());
        inkExit.resolve();
      }
      expect(await settled).toBe(stop === 'a mount failure' ? 'mount failed' : 'resolved');
    } finally {
      inkExit.resolve();
      await settled;
    }

    expect(terminal.steps.slice(started)).toEqual([
      stop === 'an Ink exit' || stop === 'a mount failure' ? 'listeners off' : 'listeners on',
      'teardown stores',
      'stop detection',
      'reap processes',
      'await the workflow',
      ...RESTORE_STEPS[path],
      'stderr note at exit',
      'stderr note during teardown',
      ...END_STEPS[stop],
    ]);
    expect(terminal.released()).toBe(true);
    expect(terminal.selecting()).toBe(false);
    expect(terminal.input.listenerCount('data')).toBe(0);
    expect(getActiveFilteredStdin()).toBeUndefined();
    const probed = terminal.steps.length;
    suspendTerminalForEditor();
    resumeTerminalAfterEditor();
    warnError('note after', undefined, 'feedback');
    expect(terminal.steps.slice(probed)).toEqual(['showCursor', 'hideCursor', 'stderr note after']);
  });

  it.each(['fullscreen', 'inline', 'fallback'] as const)(
    'turns bracketed paste on when the %s path reads keys, off for an editor and on again after it',
    async (path) => {
      vi.stubEnv('TERM_PROGRAM', undefined);
      const terminal = fakeTerminal();
      const inkExit = Promise.withResolvers<void>();
      mountInk(path, inkExit);
      const rendering = renderApp(
        createElement(Fragment),
        { fullscreen: path !== 'inline', mouse: false, projectDir },
        { exit: vi.fn() },
      );
      const pasteSteps = () => terminal.steps.filter((step) => step.endsWith('BracketedPaste'));
      try {
        await vi.waitFor(() => expect(terminal.input.listenerCount('data')).toBe(2));
        expect(pasteSteps()).toEqual(['enableBracketedPaste', 'queryBracketedPaste']);
        suspendTerminalForEditor();
        expect(pasteSteps()).toEqual([
          'enableBracketedPaste',
          'queryBracketedPaste',
          'disableBracketedPaste',
        ]);
        resumeTerminalAfterEditor();
        expect(pasteSteps()).toEqual([
          'enableBracketedPaste',
          'queryBracketedPaste',
          'disableBracketedPaste',
          'enableBracketedPaste',
        ]);
      } finally {
        inkExit.resolve();
        await rendering;
      }
    },
  );

  // A stop from outside (`kill -TSTP`) gives the terminal back to the shell, and `fg` sends the
  // SIGCONT that takes it again. The bridge still holds the terminal's word on bracketed paste.
  it.each(['fullscreen', 'inline'] as const)(
    'reads keys again with raw mode and bracketed paste on after each outside stop and fg on the %s path',
    async (path) => {
      const terminal = fakeTerminal();
      const inkExit = Promise.withResolvers<void>();
      mountInk(path, inkExit);
      const kill = vi.spyOn(process, 'kill').mockImplementation(() => true);
      const rendering = renderApp(
        createElement(Fragment),
        { fullscreen: path !== 'inline', mouse: false, projectDir },
        { exit: vi.fn() },
      );
      const pasteSteps = () => terminal.steps.filter((step) => step.endsWith('BracketedPaste'));
      try {
        await vi.waitFor(() => expect(terminal.input.listenerCount('data')).toBe(2));
        terminal.input.setRawMode(true);
        const before = pasteSteps().length;
        for (let round = 1; round <= 2; round++) {
          process.emit('SIGTSTP', 'SIGTSTP');
          expect(kill).toHaveBeenCalledTimes(round);
          expect(terminal.input.isRaw).toBe(false);
          process.emit('SIGCONT', 'SIGCONT');
          expect({
            paste: pasteSteps().slice(before),
            raw: terminal.input.isRaw,
            flowing: terminal.input.readableFlowing,
            listening: terminal.listening(),
          }).toEqual({
            paste: Array.from({ length: round }).flatMap(() => [
              'disableBracketedPaste',
              'enableBracketedPaste',
            ]),
            raw: true,
            flowing: true,
            listening: true,
          });
        }
      } finally {
        // A red run leaves the stop hand-over open; close it, so the next test gets its signals.
        if (!terminal.listening()) resumeTerminalAfterEditor();
        inkExit.resolve();
        await rendering;
      }
    },
  );

  it.each(['an Ink exit', 'a termination signal'] as const)(
    'sends a frame that Ink writes during the cleanup after %s to the terminal at once while a drag is open',
    async (stop) => {
      const terminal = fakeTerminal();
      const sent: string[] = [];
      const write = terminal.output.write;
      terminal.output.write = (chunk: string | Uint8Array) => {
        sent.push(String(chunk));
        return write(chunk);
      };
      const inkExit = Promise.withResolvers<void>();
      const ink = mountInk('fullscreen', inkExit);
      const atCleanup: boolean[] = [];
      lifecycle.teardownStores.mockImplementation(() => {
        ink.stdout?.write('frame during cleanup');
        atCleanup.push(sent.includes('frame during cleanup'));
      });
      const exit = vi.fn();
      const rendering = renderApp(
        createElement(Fragment),
        { fullscreen: true, projectDir },
        { exit },
      );
      try {
        await vi.waitFor(() => expect(terminal.input.listenerCount('data')).toBe(2));
        ink.stdout?.write('first frame');
        const painted = sent.length;
        terminal.input.write('\u001b[<0;2;1M');
        terminal.input.write('\u001b[<32;6;1M');
        await vi.waitFor(() => expect(sent.length).toBeGreaterThan(painted));
        ink.stdout?.write('frame during the drag');
        if (stop === 'an Ink exit') inkExit.resolve();
        else process.emit('SIGTERM', 'SIGTERM');
        await vi.waitFor(() => expect(atCleanup).toHaveLength(1));
        if (stop === 'a termination signal') {
          await vi.waitFor(() => expect(exit).toHaveBeenCalled());
          inkExit.resolve();
        }
        await rendering;
      } finally {
        inkExit.resolve();
        await rendering;
      }
      expect(sent.includes('frame during the drag')).toBe(false);
      expect(atCleanup).toEqual([true]);
    },
  );

  it.each([
    ['a termination signal', 'a crash', 143, []],
    ['a crash', 'a termination signal', 1, ['SPLITBRIEF crashed: boom\n']],
  ] as const)(
    'exits once with the code of %s when %s arrives during its cleanup',
    async (first, second, code, crashLines) => {
      const inkExit = Promise.withResolvers<void>();
      const workflow = Promise.withResolvers<void>();
      vi.mocked(render).mockReturnValueOnce(inkInstance(() => inkExit.promise));
      lifecycle.awaitActiveWorkflowShutdown.mockImplementation(() => workflow.promise);
      const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
      const exit = vi.fn();
      const known = new Set(process.listeners('uncaughtException'));
      const stopWith = (stop: Stop) => {
        if (stop === 'a crash') crashListener(known)?.(new Error('boom'), 'uncaughtException');
        else process.emit('SIGTERM', 'SIGTERM');
      };
      const rendering = renderApp(createElement(Fragment), { fullscreen: false }, { exit });
      try {
        stopWith(first);
        await vi.waitFor(() =>
          expect(lifecycle.awaitActiveWorkflowShutdown).toHaveBeenCalledOnce(),
        );
        stopWith(second);
        workflow.resolve();
        await vi.waitFor(() => expect(exit).toHaveBeenCalled());
        inkExit.resolve();
        await rendering;
        expect(exit).toHaveBeenCalledExactlyOnceWith(code);
        expect(
          stderr.mock.calls
            .map(([chunk]) => String(chunk))
            .filter((line) => line.startsWith('SPLITBRIEF crashed')),
        ).toEqual(crashLines);
      } finally {
        workflow.resolve();
        inkExit.resolve();
        await rendering;
      }
    },
  );

  const brokenOutput = () =>
    Promise.reject(Object.assign(new Error('write EPIPE'), { code: 'EPIPE' }));
  const unavailable = () => Promise.reject(new Error('fullscreen unavailable'));
  const settles = () => Promise.resolve();

  it.each([
    ['the fullscreen start', true, brokenOutput, settles, settles, 'resolved', 0],
    ['the wait of the fullscreen app', true, settles, brokenOutput, settles, 'resolved', 0],
    ['the wait of the inline fallback', true, unavailable, settles, brokenOutput, 'resolved', 1],
    ['the wait of the inline app', false, settles, settles, brokenOutput, 'write EPIPE', 1],
  ] as const)(
    'ends on a broken output at %s',
    async (_at, fullscreen, start, fullscreenWait, inlineWait, outcome, inlineMounts) => {
      vi.mocked(withFullScreen).mockReturnValueOnce({
        start,
        waitUntilExit: fullscreenWait,
        instance: inkInstance(),
      });
      vi.mocked(render).mockReturnValueOnce(inkInstance(inlineWait));
      vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
      const exit = vi.fn();
      const settled = await renderApp(createElement(Fragment), { fullscreen }, { exit }).then(
        () => 'resolved',
        (error: unknown) => (error instanceof Error ? error.message : 'rejected'),
      );
      expect(settled).toBe(outcome);
      expect(vi.mocked(render)).toHaveBeenCalledTimes(inlineMounts);
      expect(exit.mock.calls).toEqual(outcome === 'resolved' ? [[0]] : []);
    },
  );
});
