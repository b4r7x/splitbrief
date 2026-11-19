import { chmodSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createElement, Fragment } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { enableDebugLog, loggedDiagnostics } from '#testing/helpers/debug-log.js';
import { ensureSessionDir } from '../../core/sessions/spec-files.js';
import { sessionDir } from '../../core/paths.js';
import { acquireLiveness } from '../../engine/orchestrator/run/liveness.js';
import { createInitialState } from '../../core/state/machine.js';
import { withShutdownHandlers } from '../../engine/orchestrator/session-lifecycle/shutdown.js';
import { resetLoggerForTests } from '../../lib/logger.js';
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
vi.mock('../../lib/fs/atomic-write/write-sync.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/fs/atomic-write/write-sync.js')>();
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
  warnError(DIAGNOSTIC, new Error('\x1b[2Jrecoverable'), 'feedback');
  feedbackDuringMount.push(feedbackStore.get().message);
}

function rawDiagnosticWrites(): string[] {
  return terminalWrites.filter((write) => write.includes(DIAGNOSTIC));
}

async function expectPriorOwnerRestored(settle: () => Promise<void>): Promise<void> {
  const outer: string[] = [];
  const releaseOuter = installDiagnosticSink((message) => outer.push(message));
  try {
    await settle();
    warnError('after teardown', undefined, 'feedback');
  } finally {
    releaseOuter();
  }
  expect(outer).toEqual(['after teardown']);
}

beforeEach(() => {
  projectDir = realpathSync(mkdtempSync(join(tmpdir(), 'splitbrief-diagnostics-')));
  enableDebugLog(projectDir);
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
        warnStderr(notice);
        expect(feedbackStore.get().message).toBeNull();
        emitDiagnosticWhileMounted();
        warnStderr(notice);
        expect(feedbackStore.get().message).toBe(`${DIAGNOSTIC}: recoverable`);
        expect(feedbackStore.get().isError).toBe(true);
      },
    };

    await renderApp(createElement(Fragment), { fullscreen: true, projectDir }, { exit: vi.fn() });

    expect(loggedDiagnostics(projectDir)).toContain(notice);
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
    expect(loggedDiagnostics(projectDir)).toContain(`${DIAGNOSTIC}: recoverable`);
    expect(rawDiagnosticWrites()).toEqual([]);
  });

  it('writes a feedback diagnostic of a mounted app to the debug log exactly one time', async () => {
    ink.script.fullscreen = {
      start: async () => {},
      waitUntilExit: async () => emitDiagnosticWhileMounted(),
    };

    await renderApp(createElement(Fragment), { fullscreen: true, projectDir }, { exit: vi.fn() });

    expect(feedbackDuringMount).toEqual([`${DIAGNOSTIC}: recoverable`]);
    expect(loggedDiagnostics(projectDir).filter((line) => line.includes(DIAGNOSTIC))).toEqual([
      `${DIAGNOSTIC}: recoverable`,
    ]);
  });

  it('keeps a mounted diagnostic off the feedback line and off the terminal', async () => {
    ink.script.fullscreen = {
      start: async () => {},
      waitUntilExit: async () => {
        warnStderr(DIAGNOSTIC);
        feedbackDuringMount.push(feedbackStore.get().message);
      },
    };

    await renderApp(createElement(Fragment), { fullscreen: true, projectDir }, { exit: vi.fn() });

    expect(feedbackDuringMount).toEqual([null]);
    expect(rawDiagnosticWrites()).toEqual([]);
    expect(loggedDiagnostics(projectDir)).toContain(DIAGNOSTIC);
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
      waitUntilExit: async () => warnError(DIAGNOSTIC, new Error('\x1b[2Jrecoverable')),
    };

    await expectPriorOwnerRestored(() =>
      renderApp(createElement(Fragment), { fullscreen: true, projectDir }, { exit: vi.fn() }),
    );

    expect(loggedDiagnostics(projectDir)).toEqual(
      expect.arrayContaining([
        'Fullscreen init failed, falling back to inline mode: no alternate screen',
        `${DIAGNOSTIC}: recoverable`,
      ]),
    );
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
    expect(loggedDiagnostics(projectDir)).toContain(`${DIAGNOSTIC}: recoverable`);
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

  it('writes the run lock a quit could not release to the debug log one time and not to the terminal', async () => {
    const sessionId = '2026-10-23-create-src-kebab-js-commonjs-exporting-kebab-text-';
    let release: () => Promise<void> = async () => {};
    ink.script.fullscreen = {
      start: async () => {},
      waitUntilExit: async () => {
        release = await acquireLiveness({ projectDir, sessionId, feature: 'quit with a run' });
      },
    };

    await renderApp(createElement(Fragment), { fullscreen: true, projectDir }, { exit: vi.fn() });
    const dir = sessionDir(projectDir, sessionId);
    chmodSync(dir, 0o555);
    try {
      await release();
    } finally {
      chmodSync(dir, 0o755);
    }

    expect(loggedDiagnostics(projectDir).filter((line) => line.includes('run lock'))).toEqual([
      `Could not release the run lock: permission denied · .splitbrief/sessions/${sessionId}/lockfile.json · other SPLITBRIEF processes may have to wait for this process to exit`,
    ]);
    expect(terminalWrites.filter((write) => write.includes('run lock'))).toEqual([]);
  });
});
