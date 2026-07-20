import { describe, expect, it } from 'vitest';
import { terminalSequences } from '../../src/lib/terminal/control.js';
import {
  PTY_CHILD_EXIT_INPUT,
  PTY_CHILD_MARKER,
  PTY_CHILD_OUTPUT,
  PTY_CHILD_SCENARIO,
  PTY_CHILD_VIEWPORT,
} from './pty/child.js';
import {
  runPtySmoke,
  type PtyCapability,
  type PtyExitEvent,
  type PtyProcess,
  type PtySpawn,
} from './pty/smoke.js';

interface FakePtyState {
  active: boolean;
  argv: readonly string[];
  executable: string;
  env: Readonly<Record<string, string>>;
  resizeCalls: Array<readonly [number, number]>;
  writes: string[];
  killCalls: Array<string | undefined>;
}

function fakeCapability(mode: 'success' | 'timeout'): {
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

describe('PTY parity smoke', () => {
  it('uses fixed argv, verifies resize and restoration, then exits through supported input', async () => {
    const fake = fakeCapability('success');
    const result = await runPtySmoke(
      { viewport: PTY_CHILD_VIEWPORT, timeoutMs: 500 },
      { loadCapability: async () => fake.capability },
    );

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
    expect(Object.keys(fake.state.env).some((name) => /api|token|secret|key/iu.test(name))).toBe(
      false,
    );
  });

  it('kills the PTY process group after a forced timeout', async () => {
    const fake = fakeCapability('timeout');
    const promise = runPtySmoke(
      { viewport: PTY_CHILD_VIEWPORT, timeoutMs: 10 },
      { loadCapability: async () => fake.capability },
    );

    await expect(promise).rejects.toMatchObject({ name: 'pty-smoke-timeout' });
    expect(fake.state.killCalls).toContain('SIGTERM');
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
