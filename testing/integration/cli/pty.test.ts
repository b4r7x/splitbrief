import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { terminalSequences } from '../../../src/lib/terminal/control.js';
import { describe, expect, it } from 'vitest';
import type { PtyCapability, PtyExitEvent, PtyProcess, PtySpawn } from './pty/capability.js';
import { resolvePtySpawn } from './pty/capability.js';
import {
  PTY_ACTIVE_REVIEW_MARKER,
  PTY_APPROVAL_PREFIX,
  PTY_APPROVAL_SUFFIX,
  PTY_APPROVED_MARKER,
  PTY_CHILD_PROJECT_ENV,
  PTY_EDIT_INPUT,
  PTY_EDITOR_FINISHED_MARKER,
  PTY_EDITOR_SENTINEL_ENV,
  PTY_EDITOR_STARTED_MARKER,
  PTY_EXIT_INPUT,
  PTY_SUBMIT_INPUT,
} from './pty/contract.js';
import { runPtySmoke, safeChildEnvironment } from './pty/run.js';

interface FakePtyState {
  active: boolean;
  env: Readonly<Record<string, string>>;
  writes: string[];
  kills: Array<string | undefined>;
}

interface ListenerFailureState {
  active: boolean;
  dataDisposed: boolean;
  exitDisposed: boolean;
  environmentRoot: string;
  kills: Array<string | undefined>;
}

function fakeCapability(mode: 'success' | 'silent' | 'early-exit' | 'missing-final-restore'): {
  readonly capability: PtyCapability;
  readonly state: FakePtyState;
} {
  const state: FakePtyState = { active: false, env: {}, writes: [], kills: [] };
  const spawn: PtySpawn = (_executable, _argv, options) => {
    const dataListeners = new Set<(data: string) => void>();
    const exitListeners = new Set<(event: PtyExitEvent) => void>();
    state.active = true;
    state.env = options.env;
    let exited = false;

    const emitData = (data: string): void => {
      for (const listener of dataListeners) listener(data);
    };
    const emitExit = (event: PtyExitEvent): void => {
      if (exited) return;
      exited = true;
      state.active = false;
      for (const listener of exitListeners) listener(event);
    };

    const child: PtyProcess = {
      pid: 999_999,
      onData: (listener) => {
        dataListeners.add(listener);
        return { dispose: () => dataListeners.delete(listener) };
      },
      onExit: (listener) => {
        exitListeners.add(listener);
        return { dispose: () => exitListeners.delete(listener) };
      },
      write: (data) => {
        state.writes.push(data);
        if (mode !== 'success' && mode !== 'missing-final-restore') return;
        if (data === PTY_APPROVAL_PREFIX) {
          emitData(`› ${PTY_APPROVAL_PREFIX}`);
        } else if (data === PTY_EDIT_INPUT) {
          emitData(
            `${PTY_EDITOR_STARTED_MARKER}:2147483647\n${PTY_EDITOR_FINISHED_MARKER}:2147483647\n`,
          );
          emitData(`${PTY_ACTIVE_REVIEW_MARKER}\n› ${PTY_APPROVAL_PREFIX}`);
        } else if (data === PTY_APPROVAL_SUFFIX) {
          emitData(`› ${PTY_APPROVAL_PREFIX}${PTY_APPROVAL_SUFFIX}`);
        } else if (data === PTY_SUBMIT_INPUT) {
          emitData(
            mode === 'missing-final-restore'
              ? `${terminalSequences.exitAltBuffer}${terminalSequences.showCursor}${terminalSequences.enterAltBuffer}${terminalSequences.hideCursor}${PTY_APPROVED_MARKER}`
              : PTY_APPROVED_MARKER,
          );
        } else if (data === PTY_EXIT_INPUT) {
          if (mode === 'success') {
            emitData(`${terminalSequences.exitAltBuffer}${terminalSequences.showCursor}`);
          }
          emitExit({ exitCode: 0 });
        }
      },
      kill: (signal) => {
        state.kills.push(signal);
        emitExit({ exitCode: 143, signal: 15 });
      },
    };

    queueMicrotask(() => {
      if (mode === 'success' || mode === 'missing-final-restore') {
        emitData(
          `${terminalSequences.enterAltBuffer}${terminalSequences.hideCursor}${PTY_ACTIVE_REVIEW_MARKER}`,
        );
      } else if (mode === 'early-exit') {
        emitExit({ exitCode: 1 });
      }
    });
    return child;
  };
  return { capability: { kind: 'available', spawn }, state };
}

function listenerFailureCapability(failure: 'data' | 'exit'): {
  readonly capability: PtyCapability;
  readonly state: ListenerFailureState;
} {
  const state: ListenerFailureState = {
    active: false,
    dataDisposed: false,
    exitDisposed: false,
    environmentRoot: '',
    kills: [],
  };
  const spawn: PtySpawn = (_executable, _argv, options) => {
    state.active = true;
    state.environmentRoot = options.env.HOME ?? '';
    let exitListener: ((event: PtyExitEvent) => void) | undefined;
    return {
      pid: 999_997,
      onData: () => {
        if (failure === 'data') throw new Error('data listener registration failed');
        return {
          dispose: () => {
            state.dataDisposed = true;
          },
        };
      },
      onExit: (listener) => {
        if (failure === 'exit') throw new Error('exit listener registration failed');
        exitListener = listener;
        return {
          dispose: () => {
            state.exitDisposed = true;
            exitListener = undefined;
          },
        };
      },
      write: () => {},
      kill: (signal) => {
        state.kills.push(signal);
        state.active = false;
        exitListener?.({ exitCode: 143, signal: 15 });
      },
    };
  };
  return { capability: { kind: 'available', spawn }, state };
}

function postSpawnBoundaryCapability(): {
  readonly capability: PtyCapability;
  readonly state: { active: boolean; kills: Array<string | undefined> };
} {
  const state = { active: true, kills: [] as Array<string | undefined> };
  let exitListener: ((event: PtyExitEvent) => void) | undefined;
  const spawn = resolvePtySpawn({
    spawn: () => ({
      pid: 999_998,
      onExit: (listener: (event: PtyExitEvent) => void) => {
        exitListener = listener;
        return {
          dispose: () => {
            exitListener = undefined;
          },
        };
      },
      kill: (signal?: string) => {
        state.kills.push(signal);
        state.active = false;
        exitListener?.({ exitCode: 143, signal: 15 });
      },
    }),
  });
  if (!spawn) throw new Error('expected an adapted PTY spawn');
  return { capability: { kind: 'available', spawn }, state };
}

function unobservableBoundaryCapability(): {
  readonly capability: PtyCapability;
  readonly state: { environmentRoot: string; kills: Array<string | undefined> };
} {
  const state = { environmentRoot: '', kills: [] as Array<string | undefined> };
  const spawn = resolvePtySpawn({
    spawn: (
      _executable: string,
      _argv: readonly string[],
      options: { env: Record<string, string> },
    ) => {
      state.environmentRoot = options.env.HOME ?? '';
      return {
        pid: 999_996,
        onExit: () => {
          throw new Error('exit listener registration failed');
        },
        kill: (signal?: string) => {
          state.kills.push(signal);
        },
      };
    },
  });
  if (!spawn) throw new Error('expected an adapted PTY spawn');
  return { capability: { kind: 'available', spawn }, state };
}

function invalidDisposableBoundaryCapability(): {
  readonly capability: PtyCapability;
  readonly state: { environmentRoot: string; kills: Array<string | undefined> };
} {
  const state = { environmentRoot: '', kills: [] as Array<string | undefined> };
  let exitListener: ((event: PtyExitEvent) => void) | undefined;
  const spawn = resolvePtySpawn({
    spawn: (
      _executable: string,
      _argv: readonly string[],
      options: { env: Record<string, string> },
    ) => {
      state.environmentRoot = options.env.HOME ?? '';
      return {
        pid: 999_994,
        onExit: (listener: (event: PtyExitEvent) => void) => {
          exitListener = listener;
          return {};
        },
        kill: (signal?: string) => {
          state.kills.push(signal);
          exitListener?.({ exitCode: 143, signal: 15 });
        },
      };
    },
  });
  if (!spawn) throw new Error('expected an adapted PTY spawn');
  return { capability: { kind: 'available', spawn }, state };
}

function invalidDisposableCapability(failure: 'data' | 'exit'): {
  readonly capability: PtyCapability;
  readonly state: ListenerFailureState;
} {
  const state: ListenerFailureState = {
    active: false,
    dataDisposed: false,
    exitDisposed: false,
    environmentRoot: '',
    kills: [],
  };
  const spawn = resolvePtySpawn({
    spawn: (
      _executable: string,
      _argv: readonly string[],
      options: { env: Record<string, string> },
    ) => {
      state.active = true;
      state.environmentRoot = options.env.HOME ?? '';
      let exitListener: ((event: PtyExitEvent) => void) | undefined;
      return {
        pid: 999_995,
        onData: () => {
          if (failure === 'data') return undefined;
          return {
            dispose: () => {
              state.dataDisposed = true;
            },
          };
        },
        onExit: (listener: (event: PtyExitEvent) => void) => {
          exitListener = listener;
          if (failure === 'exit') return { dispose: 1 };
          return {
            dispose: () => {
              state.exitDisposed = true;
              exitListener = undefined;
            },
          };
        },
        write: () => {},
        kill: (signal?: string) => {
          state.kills.push(signal);
          state.active = false;
          exitListener?.({ exitCode: 143, signal: 15 });
        },
      };
    },
  });
  if (!spawn) throw new Error('expected an adapted PTY spawn');
  return { capability: { kind: 'available', spawn }, state };
}

function invalidPidCapability(pid: number): {
  readonly capability: PtyCapability;
  readonly state: Pick<ListenerFailureState, 'active' | 'environmentRoot' | 'kills'>;
} {
  const state = { active: false, environmentRoot: '', kills: [] as Array<string | undefined> };
  const spawn = resolvePtySpawn({
    spawn: (
      _executable: string,
      _argv: readonly string[],
      options: { env: Record<string, string> },
    ) => {
      state.active = true;
      state.environmentRoot = options.env.HOME ?? '';
      let exitListener: ((event: PtyExitEvent) => void) | undefined;
      return {
        pid,
        onData: () => ({ dispose: () => {} }),
        onExit: (listener: (event: PtyExitEvent) => void) => {
          exitListener = listener;
          return { dispose: () => {} };
        },
        write: () => {},
        kill: (signal?: string) => {
          state.kills.push(signal);
          state.active = false;
          exitListener?.({ exitCode: 143, signal: 15 });
        },
      };
    },
  });
  if (!spawn) throw new Error('expected an adapted PTY spawn');
  return { capability: { kind: 'available', spawn }, state };
}

function hardKillProjectCapability(): {
  readonly capability: PtyCapability;
  readonly state: {
    dataDisposed: boolean;
    projectDir: string;
    kills: Array<{ readonly projectExisted: boolean; readonly signal: string | undefined }>;
  };
} {
  const state = {
    dataDisposed: false,
    projectDir: '',
    kills: [] as Array<{
      readonly projectExisted: boolean;
      readonly signal: string | undefined;
    }>,
  };
  const spawn: PtySpawn = (_executable, _argv, options) => {
    state.projectDir = options.env[PTY_CHILD_PROJECT_ENV] ?? '';
    mkdirSync(state.projectDir);
    return {
      pid: 999_993,
      onData: () => ({
        dispose: () => {
          state.dataDisposed = true;
        },
      }),
      onExit: () => {
        throw new Error('exit observation unavailable');
      },
      write: () => {},
      kill: (signal) => {
        state.kills.push({ signal, projectExisted: existsSync(state.projectDir) });
      },
    };
  };
  return { capability: { kind: 'available', spawn }, state };
}

describe('PTY behavior smoke', () => {
  it('completes active review, editor return, approval, restoration, and reaping in order', async () => {
    const fake = fakeCapability('success');
    const result = await runPtySmoke(
      { timeoutMs: 500, requirement: 'required' },
      { loadCapability: async () => fake.capability },
    );

    expect(result).toMatchObject({
      status: 'passed',
      exitCode: 0,
      editorReturned: true,
      approved: true,
      terminalRestored: true,
      processGroupReaped: true,
    });
    expect(fake.state.writes).toEqual([
      PTY_APPROVAL_PREFIX,
      PTY_EDIT_INPUT,
      PTY_APPROVAL_SUFFIX,
      PTY_SUBMIT_INPUT,
      PTY_EXIT_INPUT,
    ]);
    expect(fake.state.active).toBe(false);
  });

  it('allows setup-only skips in optional mode and rejects them in required mode', async () => {
    const unavailable: PtyCapability = {
      kind: 'setup-failed',
      category: 'module-unavailable',
      reason: 'node-pty is unavailable on this platform',
    };
    await expect(
      runPtySmoke(
        { timeoutMs: 100, requirement: 'optional' },
        { loadCapability: async () => unavailable },
      ),
    ).resolves.toEqual({
      status: 'skipped',
      category: 'module-unavailable',
      reason: 'node-pty is unavailable on this platform',
    });
    await expect(
      runPtySmoke(
        { timeoutMs: 100, requirement: 'required' },
        { loadCapability: async () => unavailable },
      ),
    ).rejects.toMatchObject({ name: 'pty-setup-module-unavailable' });

    const incompatibleSetup: PtyCapability = {
      kind: 'setup-failed',
      category: 'api-incompatible',
      reason: 'node-pty has an incompatible spawn API',
    };
    await expect(
      runPtySmoke(
        { timeoutMs: 100, requirement: 'optional' },
        { loadCapability: async () => incompatibleSetup },
      ),
    ).resolves.toMatchObject({ status: 'skipped', category: 'api-incompatible' });

    const spawnFailure: PtyCapability = {
      kind: 'available',
      spawn: () => {
        throw new Error('host path and secret must not escape');
      },
    };
    await expect(
      runPtySmoke(
        { timeoutMs: 100, requirement: 'optional' },
        { loadCapability: async () => spawnFailure },
      ),
    ).resolves.toEqual({
      status: 'skipped',
      category: 'spawn-failed',
      reason: 'node-pty could not create a pseudoterminal',
    });
    await expect(
      runPtySmoke(
        { timeoutMs: 100, requirement: 'required' },
        { loadCapability: async () => spawnFailure },
      ),
    ).rejects.toMatchObject({ name: 'pty-setup-spawn-failed' });
  });

  it('reaps the child when the spawned process omits the data and write API', async () => {
    const failed = postSpawnBoundaryCapability();
    await expect(
      runPtySmoke(
        { timeoutMs: 100, requirement: 'optional' },
        { loadCapability: async () => failed.capability },
      ),
    ).rejects.toMatchObject({ name: 'pty-contract-api-incompatible' });

    expect(failed.state.kills).toEqual(['SIGTERM']);
    expect(failed.state.active).toBe(false);
  });

  it('hard-kills and reports unobservable cleanup when the boundary cannot register an exit listener', async () => {
    const failed = unobservableBoundaryCapability();
    await expect(
      runPtySmoke(
        { timeoutMs: 100, requirement: 'optional' },
        { loadCapability: async () => failed.capability },
      ),
    ).rejects.toMatchObject({
      name: 'pty-contract-cleanup',
      cause: { name: 'pty-contract-listener' },
    });

    expect(failed.state.kills).toEqual(['SIGTERM', 'SIGKILL']);
    expect(existsSync(failed.state.environmentRoot)).toBe(false);
  });

  it('rejects an invalid exit disposable from the boundary and reaps the child', async () => {
    const failed = invalidDisposableBoundaryCapability();
    await expect(
      runPtySmoke(
        { timeoutMs: 100, requirement: 'optional' },
        { loadCapability: async () => failed.capability },
      ),
    ).rejects.toMatchObject({ name: 'pty-contract-listener' });

    expect(failed.state.kills).toEqual(['SIGTERM']);
    expect(existsSync(failed.state.environmentRoot)).toBe(false);
  });

  it('times out and reaps a child that never speaks', async () => {
    const timedOut = fakeCapability('silent');
    await expect(
      runPtySmoke(
        { timeoutMs: 10, requirement: 'optional' },
        { loadCapability: async () => timedOut.capability },
      ),
    ).rejects.toMatchObject({ name: 'pty-contract-timeout' });

    expect(timedOut.state.kills).toEqual(['SIGTERM']);
    expect(timedOut.state.active).toBe(false);
  });

  it('reports an incomplete contract when the child exits before the review starts', async () => {
    const earlyExit = fakeCapability('early-exit');
    await expect(
      runPtySmoke(
        { timeoutMs: 100, requirement: 'optional' },
        { loadCapability: async () => earlyExit.capability },
      ),
    ).rejects.toMatchObject({ name: 'pty-contract-incomplete' });

    expect(earlyExit.state.active).toBe(false);
  });

  it.each(['optional', 'required'] as const)(
    'reaps and disposes after data listener registration fails in %s mode',
    async (requirement) => {
      const failed = listenerFailureCapability('data');
      await expect(
        runPtySmoke(
          { timeoutMs: 100, requirement },
          { loadCapability: async () => failed.capability },
        ),
      ).rejects.toMatchObject({ name: 'pty-contract-listener' });

      expect(failed.state.kills).toEqual(['SIGTERM']);
      expect(failed.state.active).toBe(false);
      expect(failed.state.exitDisposed).toBe(true);
      expect(existsSync(failed.state.environmentRoot)).toBe(false);
    },
  );

  it.each(['optional', 'required'] as const)(
    'rejects an invalid data disposable and reaps the child in %s mode',
    async (requirement) => {
      const failed = invalidDisposableCapability('data');
      await expect(
        runPtySmoke(
          { timeoutMs: 100, requirement },
          { loadCapability: async () => failed.capability },
        ),
      ).rejects.toMatchObject({ name: 'pty-contract-listener' });

      expect(failed.state.kills).toEqual(['SIGTERM']);
      expect(failed.state.exitDisposed).toBe(true);
      expect(failed.state.active).toBe(false);
      expect(existsSync(failed.state.environmentRoot)).toBe(false);
    },
  );

  it.each([
    { pid: 0, requirement: 'optional' as const },
    { pid: 0, requirement: 'required' as const },
    { pid: Number.NaN, requirement: 'optional' as const },
    { pid: Number.NaN, requirement: 'required' as const },
  ])('direct-kills an incompatible PID $pid in $requirement mode', async ({ pid, requirement }) => {
    const failed = invalidPidCapability(pid);
    await expect(
      runPtySmoke(
        { timeoutMs: 100, requirement },
        { loadCapability: async () => failed.capability },
      ),
    ).rejects.toMatchObject({ name: 'pty-contract-api-incompatible' });

    expect(failed.state.kills).toEqual(['SIGTERM']);
    expect(failed.state.active).toBe(false);
    expect(existsSync(failed.state.environmentRoot)).toBe(false);
  });

  it('keeps the parent-owned project through hard-kill and removes it afterward', async () => {
    const failed = hardKillProjectCapability();
    await expect(
      runPtySmoke(
        { timeoutMs: 100, requirement: 'optional' },
        { loadCapability: async () => failed.capability },
      ),
    ).rejects.toMatchObject({ name: 'pty-contract-cleanup' });

    expect(failed.state.kills).toEqual([
      { signal: 'SIGTERM', projectExisted: true },
      { signal: 'SIGKILL', projectExisted: true },
    ]);
    expect(failed.state.dataDisposed).toBe(true);
    expect(existsSync(failed.state.projectDir)).toBe(false);
  });

  it('disposes the data listener and reports unobservable cleanup after exit registration fails', async () => {
    const failed = listenerFailureCapability('exit');
    let thrown: unknown;
    try {
      await runPtySmoke(
        { timeoutMs: 100, requirement: 'optional' },
        { loadCapability: async () => failed.capability },
      );
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toMatchObject({
      name: 'pty-contract-cleanup',
      cause: { name: 'pty-contract-listener' },
    });
    expect(failed.state.kills).toEqual(['SIGTERM', 'SIGKILL']);
    expect(failed.state.active).toBe(false);
    expect(failed.state.dataDisposed).toBe(true);
    expect(existsSync(failed.state.environmentRoot)).toBe(false);
  });

  it.each(['optional', 'required'] as const)(
    'rejects an invalid exit disposable after observable reaping in %s mode',
    async (requirement) => {
      const failed = invalidDisposableCapability('exit');
      await expect(
        runPtySmoke(
          { timeoutMs: 100, requirement },
          { loadCapability: async () => failed.capability },
        ),
      ).rejects.toMatchObject({ name: 'pty-contract-listener' });

      expect(failed.state.kills).toEqual(['SIGTERM']);
      expect(failed.state.dataDisposed).toBe(true);
      expect(failed.state.active).toBe(false);
      expect(existsSync(failed.state.environmentRoot)).toBe(false);
    },
  );

  it('requires restoration after the latest terminal re-entry', async () => {
    const missingFinalRestore = fakeCapability('missing-final-restore');
    await expect(
      runPtySmoke(
        { timeoutMs: 100, requirement: 'required' },
        { loadCapability: async () => missingFinalRestore.capability },
      ),
    ).rejects.toMatchObject({ name: 'pty-contract-restoration' });
    expect(missingFinalRestore.state.active).toBe(false);
  });

  it('builds an isolated allowlisted child environment', () => {
    const root = '/tmp/splitbrief-pty-environment-contract';
    const env = safeChildEnvironment(root);
    expect(env.HOME).toBe(root);
    expect(env.USERPROFILE).toBe(root);
    expect(env.XDG_CONFIG_HOME).toBe(join(root, 'xdg'));
    expect(env[PTY_CHILD_PROJECT_ENV]).toBe(join(root, 'project'));
    expect(env[PTY_EDITOR_SENTINEL_ENV]).toBe(join(root, 'editor-ran'));
    expect(env.VISUAL).toContain('editor-child.ts');
    expect(env.EDITOR).toBeUndefined();
    expect(env.NODE_OPTIONS).toBeUndefined();
    expect(env.OPENAI_API_KEY).toBeUndefined();
  });
});
