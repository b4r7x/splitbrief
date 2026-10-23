import { mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createElement, Fragment } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ensureSessionDir } from '../../core/paths-io.js';
import { createInitialState } from '../../core/state/machine.js';
import { withShutdownHandlers } from '../../engine/orchestrator/session-lifecycle/shutdown.js';
import { configureLogger, resetLoggerForTests } from '../../lib/logger.js';
import { terminalSequences } from '../../lib/terminal/control.js';
import { installDiagnosticSink, warnError, warnStderr } from '../../lib/warn.js';
import { feedbackStore } from '../../stores/ui/feedback.js';
import { renderApp } from './app.js';

const DIAGNOSTIC = 'AUDIT_SYNTHETIC_DIAGNOSTIC';

interface MountScript {
  start: () => Promise<void>;
  waitUntilExit: (unmounted: Promise<void>) => Promise<void>;
}

const ink = vi.hoisted(() => {
  const script = {
    fullscreen: undefined as MountScript | undefined,
    inline: undefined as MountScript | undefined,
  };
  const mount = (mountScript: MountScript | undefined) => {
    let unmount = () => {};
    const unmounted = new Promise<void>((resolve) => {
      unmount = resolve;
    });
    return {
      instance: {
        unmount,
        rerender: () => {},
        cleanup: () => {},
        clear: () => {},
        waitUntilExit: () => mountScript?.waitUntilExit(unmounted) ?? Promise.resolve(),
      },
      start: () => mountScript?.start() ?? Promise.resolve(),
    };
  };
  return { script, mount };
});

// A state.json write renamed into place that SPLITBRIEF could not confirm on disk.
const stateWrite = vi.hoisted(() => ({ unconfirmed: false }));
vi.mock('../../lib/confined-fs-atomic.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/confined-fs-atomic.js')>();
  return {
    ...actual,
    confinedAtomicWriteFileSync: (
      ...args: Parameters<typeof actual.confinedAtomicWriteFileSync>
    ): ReturnType<typeof actual.confinedAtomicWriteFileSync> => {
      const written = actual.confinedAtomicWriteFileSync(...args);
      return stateWrite.unconfirmed && written.kind === 'written'
        ? { kind: 'durability-uncertain', observedRevision: written.revision }
        : written;
    },
  };
});

vi.mock('ink', async (importOriginal) => {
  const actual = await importOriginal<typeof import('ink')>();
  return { ...actual, render: () => ink.mount(ink.script.inline).instance };
});

vi.mock('fullscreen-ink', () => ({
  withFullScreen: () => {
    const mounted = ink.mount(ink.script.fullscreen);
    return {
      instance: mounted.instance,
      start: mounted.start,
      waitUntilExit: mounted.instance.waitUntilExit,
    };
  },
}));

let projectDir: string;
let terminalWrites: string[];
let feedbackDuringMount: (string | null)[];

function emitDiagnosticWhileMounted(): void {
  warnError(DIAGNOSTIC, new Error('\x1b[2Jrecoverable'));
  feedbackDuringMount.push(feedbackStore.get().message);
}

function debugLog(): string {
  return readFileSync(join(projectDir, 'debug.log'), 'utf8');
}

function rawDiagnosticWrites(): string[] {
  return terminalWrites.filter((write) => write.includes(DIAGNOSTIC));
}

async function expectPriorOwnerRestored(settle: () => Promise<void>): Promise<void> {
  const outer: string[] = [];
  const releaseOuter = installDiagnosticSink((message) => outer.push(message));
  try {
    await settle();
    warnError('after teardown');
  } finally {
    releaseOuter();
  }
  expect(outer).toEqual(['after teardown']);
}

beforeEach(() => {
  projectDir = realpathSync(mkdtempSync(join(tmpdir(), 'splitbrief-diagnostics-')));
  configureLogger({ projectDir, relativePath: 'debug.log', enabled: true });
  terminalWrites = [];
  feedbackDuringMount = [];
  const record = (chunk: string | Uint8Array) => {
    terminalWrites.push(String(chunk));
    return true;
  };
  vi.spyOn(process.stdout, 'write').mockImplementation(record);
  vi.spyOn(process.stderr, 'write').mockImplementation(record);
  vi.spyOn(process, 'exit').mockImplementation(() => {
    throw new Error('Unexpected process exit');
  });
  ink.script.fullscreen = undefined;
  ink.script.inline = undefined;
});

afterEach(() => {
  stateWrite.unconfirmed = false;
  vi.restoreAllMocks();
  feedbackStore.reset();
  resetLoggerForTests();
  rmSync(projectDir, { recursive: true, force: true });
});

describe('renderApp diagnostics ownership', () => {
  it('logs background notices without replacing actionable feedback', async () => {
    const notice = `${DIAGNOSTIC} recovered optional metadata`;
    ink.script.fullscreen = {
      start: async () => {},
      waitUntilExit: async () => {
        warnStderr(notice, 'log-only');
        expect(feedbackStore.get().message).toBeNull();
        emitDiagnosticWhileMounted();
        warnStderr(notice, 'log-only');
        expect(feedbackStore.get().message).toBe(`${DIAGNOSTIC}: recoverable`);
        expect(feedbackStore.get().isError).toBe(true);
      },
    };

    await renderApp(createElement(Fragment), { fullscreen: true, projectDir }, { exit: vi.fn() });

    expect(debugLog()).toContain(`[diagnostics] ${notice}`);
    expect(rawDiagnosticWrites()).toEqual([]);
  });

  it('routes a mounted fullscreen diagnostic to the log and feedback, then hands ownership back', async () => {
    ink.script.fullscreen = {
      start: async () => {},
      waitUntilExit: async () => emitDiagnosticWhileMounted(),
    };

    await expectPriorOwnerRestored(() =>
      renderApp(createElement(Fragment), { fullscreen: true, projectDir }, { exit: vi.fn() }),
    );

    expect(feedbackDuringMount).toEqual([`${DIAGNOSTIC}: recoverable`]);
    expect(debugLog()).toContain(`[diagnostics] ${DIAGNOSTIC}: recoverable`);
    expect(rawDiagnosticWrites()).toEqual([]);
  });

  it('keeps the fullscreen fallback warning and inline diagnostics off the terminal', async () => {
    ink.script.fullscreen = {
      start: async () => {
        throw new Error('no alternate screen');
      },
      waitUntilExit: async () => {},
    };
    ink.script.inline = {
      start: async () => {},
      waitUntilExit: async () => emitDiagnosticWhileMounted(),
    };

    await expectPriorOwnerRestored(() =>
      renderApp(createElement(Fragment), { fullscreen: true, projectDir }, { exit: vi.fn() }),
    );

    expect(debugLog()).toContain('Fullscreen init failed, falling back to inline mode');
    expect(feedbackDuringMount).toEqual([`${DIAGNOSTIC}: recoverable`]);
    expect(terminalWrites.filter((write) => write.includes('Fullscreen init failed'))).toEqual([]);
    expect(rawDiagnosticWrites()).toEqual([]);
  });

  it('releases the sink when the mount rejects', async () => {
    ink.script.inline = {
      start: async () => {},
      waitUntilExit: async () => {
        emitDiagnosticWhileMounted();
        throw new Error('mount crashed');
      },
    };

    await expectPriorOwnerRestored(() =>
      expect(renderApp(createElement(Fragment), { fullscreen: false, projectDir })).rejects.toThrow(
        'mount crashed',
      ),
    );

    expect(feedbackDuringMount).toEqual([`${DIAGNOSTIC}: recoverable`]);
    expect(rawDiagnosticWrites()).toEqual([]);
  });

  it('releases the sink when the caller aborts the mount', async () => {
    const unmount = new AbortController();
    ink.script.fullscreen = {
      start: async () => {},
      waitUntilExit: async (unmounted) => {
        emitDiagnosticWhileMounted();
        await unmounted;
      },
    };

    await expectPriorOwnerRestored(async () => {
      const rendering = renderApp(createElement(Fragment), {
        fullscreen: true,
        projectDir,
        unmountSignal: unmount.signal,
      });
      await vi.waitFor(() => expect(feedbackDuringMount).toHaveLength(1));
      unmount.abort();
      await rendering;
    });

    expect(feedbackDuringMount).toEqual([`${DIAGNOSTIC}: recoverable`]);
    expect(rawDiagnosticWrites()).toEqual([]);
  });

  it('writes a diagnostic the feedback line rejects to stderr only after the terminal is restored', async () => {
    const unsubscribe = feedbackStore.subscribe(() => {
      throw new Error('feedback listener failed');
    });
    let writesWhileMounted: string[] = [];
    ink.script.fullscreen = {
      start: async () => {},
      waitUntilExit: async () => {
        emitDiagnosticWhileMounted();
        writesWhileMounted = rawDiagnosticWrites();
      },
    };

    try {
      await renderApp(createElement(Fragment), { fullscreen: true, projectDir }, { exit: vi.fn() });
    } finally {
      unsubscribe();
    }

    expect(writesWhileMounted).toEqual([]);
    const restoredAt = terminalWrites.indexOf(terminalSequences.exitAltBuffer);
    const reportedAt = terminalWrites.indexOf(`${DIAGNOSTIC}: recoverable\n`);
    expect(restoredAt).toBeGreaterThanOrEqual(0);
    expect(reportedAt).toBeGreaterThan(restoredAt);
    expect(rawDiagnosticWrites()).toHaveLength(1);
    expect(debugLog()).toContain(`${DIAGNOSTIC}: recoverable`);
  });
  it('writes an at-exit note to stderr only after the terminal is restored, never to the feedback line', async () => {
    let writesWhileMounted: string[] = [];
    ink.script.fullscreen = {
      start: async () => {},
      waitUntilExit: async () => {
        warnStderr(DIAGNOSTIC, 'at-exit');
        feedbackDuringMount.push(feedbackStore.get().message);
        writesWhileMounted = rawDiagnosticWrites();
      },
    };

    await renderApp(createElement(Fragment), { fullscreen: true, projectDir }, { exit: vi.fn() });

    expect(writesWhileMounted).toEqual([]);
    expect(feedbackDuringMount).toEqual([null]);
    const restoredAt = terminalWrites.indexOf(terminalSequences.exitAltBuffer);
    expect(terminalWrites.indexOf(`${DIAGNOSTIC}\n`)).toBeGreaterThan(restoredAt);
    expect(restoredAt).toBeGreaterThanOrEqual(0);
    expect(rawDiagnosticWrites()).toHaveLength(1);
  });

  it('writes an unconfirmed state save at quit to stderr once, after the terminal is restored', async () => {
    ensureSessionDir(projectDir, 'sess-quit');
    stateWrite.unconfirmed = true;
    let endRun = () => {};
    let run: Promise<unknown> = Promise.resolve();
    ink.script.fullscreen = {
      start: async () => {},
      waitUntilExit: async () => {
        run = withShutdownHandlers(
          {
            projectDir,
            sessionId: 'sess-quit',
            getTrackedState: () => createInitialState('quit with a run'),
            getCurrentTask: () => undefined,
          },
          () =>
            new Promise<void>((resolve) => {
              endRun = resolve;
            }),
        );
      },
    };

    await renderApp(createElement(Fragment), { fullscreen: true, projectDir }, { exit: vi.fn() });
    endRun();
    await run;

    const line =
      'Saved the run state, but could not confirm it on disk · .splitbrief/sessions/sess-quit/state.json\n';
    expect(terminalWrites.filter((write) => write.includes('state'))).toEqual([line]);
    const restoredAt = terminalWrites.indexOf(terminalSequences.exitAltBuffer);
    expect(restoredAt).toBeGreaterThanOrEqual(0);
    expect(terminalWrites.indexOf(line)).toBeGreaterThan(restoredAt);
  });
});
