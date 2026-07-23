import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { join } from 'node:path';
import { terminalSequences } from '../../src/lib/terminal/control.js';
import { cleanupTempDir, createTempDir } from '#testing/helpers/temp-dir.js';
import {
  PTY_CHILD_EXIT_INPUT,
  PTY_CHILD_MARKER,
  PTY_CHILD_OUTPUT,
  PTY_CHILD_SCENARIO,
  PTY_CHILD_VIEWPORT,
} from './pty/child.js';
import type { PtyCapability, PtyExitEvent, PtyProcess, PtySpawn } from './pty/smoke/capability.js';
import { runPtySmoke, safeChildEnvironment } from './pty/smoke/run.js';

interface FakePtyState {
  active: boolean;
  argv: readonly string[];
  executable: string;
  env: Readonly<Record<string, string>>;
  resizeCalls: Array<readonly [number, number]>;
  writes: string[];
  killCalls: Array<string | undefined>;
}

function fakeCapability(mode: 'success' | 'unresponsive'): {
  readonly capability: PtyCapability;
  readonly state: FakePtyState;
} {
  const dataListeners = new Set<(data: string) => void>();
  const exitListeners = new Set<(event: PtyExitEvent) => void>();
  const state: FakePtyState = {
    active: false,
    argv: [],
    executable: '',
    env: {},
    resizeCalls: [],
    writes: [],
    killCalls: [],
  };
  const spawn: PtySpawn = (executable, argv, options) => {
    state.active = true;
    state.executable = executable;
    state.argv = argv;
    state.env = options.env;
    let cols = options.cols;
    let rows = options.rows;
    let exited = false;
    const emitExit = (event: PtyExitEvent) => {
      if (exited) return;
      exited = true;
      state.active = false;
      for (const listener of exitListeners) listener(event);
    };
    const process: PtyProcess = {
      pid: 999_999,
      get cols() {
        return cols;
      },
      get rows() {
        return rows;
      },
      onData: (listener) => {
        dataListeners.add(listener);
        return { dispose: () => dataListeners.delete(listener) };
      },
      onExit: (listener) => {
        exitListeners.add(listener);
        return { dispose: () => exitListeners.delete(listener) };
      },
      resize: (nextCols, nextRows) => {
        cols = nextCols;
        rows = nextRows;
        state.resizeCalls.push([nextCols, nextRows]);
      },
      write: (data) => {
        state.writes.push(String(data));
        if (mode !== 'success' || data !== PTY_CHILD_EXIT_INPUT) return;
        for (const listener of dataListeners) {
          listener(`${terminalSequences.exitAltBuffer}${terminalSequences.showCursor}`);
        }
        emitExit({ exitCode: 0 });
      },
      kill: (signal) => {
        state.killCalls.push(signal);
        if (mode === 'unresponsive') {
          if (signal === 'SIGKILL') {
            emitExit({ exitCode: 137, signal: 9 });
          }
          return;
        }
        emitExit({ exitCode: 143, signal: 15 });
      },
    };
    if (mode === 'success') {
      queueMicrotask(() => {
        for (const listener of dataListeners) {
          listener(
            `${terminalSequences.enterAltBuffer}${terminalSequences.hideCursor}${PTY_CHILD_MARKER}`,
          );
        }
      });
    }
    return process;
  };
  return { capability: { kind: 'available', spawn }, state };
}

const PTY_ENV_ALLOWLIST = [
  'HOME',
  'USERPROFILE',
  'XDG_CONFIG_HOME',
  'TMPDIR',
  'TEMP',
  'TMP',
  'TERM',
  'COLORTERM',
  'FORCE_COLOR',
  'LANG',
  'LC_ALL',
  'TZ',
  'GIT_CONFIG_NOSYSTEM',
  'GIT_TERMINAL_PROMPT',
  'DIPTYCH_QUIET',
  'NODE_NO_WARNINGS',
] as const;

const PTY_ENV_PLATFORM_KEYS = ['PATH', 'SystemRoot', 'WINDIR', 'ComSpec', 'PATHEXT'] as const;

const HOST_ONLY_SENTINEL = 'DIPTYCH_HOST_ONLY_SENTINEL';

describe('PTY parity smoke', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('uses fixed argv, verifies resize and restoration, then exits through supported input', async () => {
    const environmentRoot = createTempDir('diptych-pty-environment-test');
    const priorSentinel = process.env[HOST_ONLY_SENTINEL];
    process.env[HOST_ONLY_SENTINEL] = 'host-only-value';
    try {
      const isolated = safeChildEnvironment(environmentRoot);
      expect(isolated[HOST_ONLY_SENTINEL]).toBeUndefined();
      expect(isolated.HOME).toBe(environmentRoot);
      expect(isolated.USERPROFILE).toBe(environmentRoot);
      expect(isolated.XDG_CONFIG_HOME).toBe(join(environmentRoot, 'xdg'));
      const expectedKeys = new Set<string>(PTY_ENV_ALLOWLIST);
      for (const name of PTY_ENV_PLATFORM_KEYS) {
        if (process.env[name]) expectedKeys.add(name);
      }
      expect(new Set(Object.keys(isolated))).toEqual(expectedKeys);
    } finally {
      if (priorSentinel === undefined) delete process.env[HOST_ONLY_SENTINEL];
      else process.env[HOST_ONLY_SENTINEL] = priorSentinel;
      cleanupTempDir(environmentRoot);
    }

    const fake = fakeCapability('success');
    const resultPromise = runPtySmoke(
      { viewport: PTY_CHILD_VIEWPORT, timeoutMs: 500 },
      { loadCapability: async () => fake.capability },
    );
    await vi.runAllTimersAsync();
    const result = await resultPromise;

    expect(result.status).toBe('passed');
    expect(fake.state.executable).toBe(process.execPath);
    expect(fake.state.argv.slice(-4)).toEqual([
      '--scenario',
      PTY_CHILD_SCENARIO,
      '--output',
      PTY_CHILD_OUTPUT,
    ]);
    expect(fake.state.resizeCalls).toEqual([
      [PTY_CHILD_VIEWPORT.cols + 1, PTY_CHILD_VIEWPORT.rows + 1],
      [PTY_CHILD_VIEWPORT.cols, PTY_CHILD_VIEWPORT.rows],
    ]);
    expect(fake.state.writes).toEqual([PTY_CHILD_EXIT_INPUT]);
    expect(fake.state.active).toBe(false);
    expect(fake.state.env[HOST_ONLY_SENTINEL]).toBeUndefined();
    expect(fake.state.env.HOME).not.toBe(process.env.HOME);
    expect(fake.state.env.HOME).toBe(fake.state.env.USERPROFILE);
    const home = fake.state.env.HOME;
    expect(home).toBeDefined();
    expect(fake.state.env.XDG_CONFIG_HOME).toBe(join(home as string, 'xdg'));
    const spawnKeys = new Set(Object.keys(fake.state.env));
    const expectedSpawnKeys = new Set<string>(PTY_ENV_ALLOWLIST);
    for (const name of PTY_ENV_PLATFORM_KEYS) {
      if (process.env[name]) expectedSpawnKeys.add(name);
    }
    expect(spawnKeys).toEqual(expectedSpawnKeys);
  });

  it('kills the PTY process group after a forced timeout', async () => {
    const fake = fakeCapability('unresponsive');
    const promise = runPtySmoke(
      { viewport: PTY_CHILD_VIEWPORT, timeoutMs: 10 },
      { loadCapability: async () => fake.capability },
    );

    const asserted = expect(promise).rejects.toMatchObject({ name: 'pty-smoke-timeout' });

    await vi.advanceTimersByTimeAsync(10);
    await vi.advanceTimersByTimeAsync(250);
    await asserted;

    expect(fake.state.killCalls).toEqual(['SIGTERM', 'SIGKILL']);
    expect(fake.state.active).toBe(false);
  });

  it('returns an explicit successful skip when node-pty is unavailable', async () => {
    await expect(
      runPtySmoke(
        { viewport: PTY_CHILD_VIEWPORT, timeoutMs: 100 },
        {
          loadCapability: async () => ({
            kind: 'unavailable',
            reason: 'node-pty optional capability is unavailable on this platform',
          }),
        },
      ),
    ).resolves.toEqual({
      status: 'skipped',
      reason: 'node-pty optional capability is unavailable on this platform',
    });
  });
});
