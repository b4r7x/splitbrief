import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { processError } from '../../lib/process/errors.js';
import {
  killAllProcesses,
  registerProcess,
  unregisterProcess,
} from '../../lib/process/registry.js';
import {
  createServerCleanup,
  createServerExitHandlers,
  createServerProcessCleanup,
} from './server-cleanup.js';

describe('detached server cleanup ordering', () => {
  const leaders: ReturnType<typeof spawn>[] = [];
  const fixtureDirs: string[] = [];

  afterEach(async () => {
    await killAllProcesses();
    for (const leader of leaders.splice(0)) unregisterProcess(leader);
    for (const dir of fixtureDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  async function createLifecycleProbe() {
    const dir = mkdtempSync(join(tmpdir(), 'server-entry-cleanup-'));
    fixtureDirs.push(dir);
    const marker = join(dir, 'grandchild-exit');
    const grandchildScript = [
      'const { appendFileSync } = require("node:fs");',
      'const marker = process.argv[1];',
      'process.on("SIGTERM", () => { appendFileSync(marker, "grandchild-exit\\n"); process.exit(0); });',
      'process.stdout.write("ready");',
      'setInterval(() => {}, 1000);',
    ].join('');
    const leaderScript = [
      'const { spawn } = require("node:child_process");',
      'const marker = process.argv[1];',
      'const script = process.argv[2];',
      'const child = spawn(process.execPath, ["-e", script, marker], { stdio: ["ignore", "pipe", "ignore"] });',
      'child.stdout.once("data", () => process.stdout.write("ready"));',
      'process.on("SIGTERM", () => process.exit(0));',
      'setInterval(() => {}, 1000);',
    ].join('');
    const leader = spawn(process.execPath, ['-e', leaderScript, marker, grandchildScript], {
      detached: true,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    leaders.push(leader);
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('grandchild did not become ready')), 3000);
      leader.stdout?.once('data', () => {
        clearTimeout(timeout);
        resolve();
      });
    });
    registerProcess(leader, { group: true, ledger: false });

    const stages: Array<{ stage: string; grandchildExited: boolean }> = [];
    const captureStage = (stage: string) => {
      stages.push({ stage, grandchildExited: existsSync(marker) });
    };
    const cleanup = createServerCleanup({
      cleanupProcesses: createServerProcessCleanup(),
      stopHeartbeat: () => captureStage('heartbeat-stopped'),
      closeBridge: () => captureStage('bridge-closed'),
      closeServer: async () => captureStage('server-closed'),
      terminalize: async (termination) => captureStage(`terminalized:${termination.kind}`),
      flushTelemetry: async () => captureStage('telemetry-flushed'),
    });
    const exits: Array<{ code: number; grandchildExited: boolean }> = [];
    const handlers = createServerExitHandlers({
      cleanup,
      exitProcess: (code) => exits.push({ code, grandchildExited: existsSync(marker) }),
    });
    return { cleanup, exits, handlers, stages };
  }

  it('coalesces repeated cleanup and reaps the grandchild before IPC close and terminalization', async () => {
    const { cleanup, stages } = await createLifecycleProbe();

    const first = cleanup({ kind: 'exit', exitCode: 0 });
    const repeated = cleanup({ kind: 'signal', signal: 'SIGTERM' });

    expect(repeated).toBe(first);
    await first;
    expect(stages).toEqual([
      { stage: 'heartbeat-stopped', grandchildExited: false },
      { stage: 'bridge-closed', grandchildExited: true },
      { stage: 'server-closed', grandchildExited: true },
      { stage: 'terminalized:exit', grandchildExited: true },
      { stage: 'telemetry-flushed', grandchildExited: true },
    ]);
  });

  it('signal exit waits for the grandchild-exit marker', async () => {
    const { exits, handlers } = await createLifecycleProbe();

    await handlers.signal('SIGTERM');

    expect(exits).toEqual([{ code: 0, grandchildExited: true }]);
  });

  it.each([
    ['unhandled rejection crash', new Error('rejected')],
    ['uncaught exception crash', new Error('thrown')],
  ])('%s exit waits for the grandchild-exit marker', async (_label, reason) => {
    const { exits, handlers } = await createLifecycleProbe();

    await handlers.crash(reason);

    expect(exits).toEqual([{ code: 1, grandchildExited: true }]);
  });

  it('top-level main rejection exit waits for the grandchild-exit marker', async () => {
    const { exits, handlers } = await createLifecycleProbe();

    await Promise.reject(new Error('startup failed')).catch(handlers.crash);

    expect(exits).toEqual([{ code: 1, grandchildExited: true }]);
  });

  function createUnreapedGroupProbe() {
    const limitation = processError.platformLimitation({
      operation: 'verify-absence',
      target: 'process-group',
      signal: 'SIGKILL',
    });
    const stages: string[] = [];
    const cleanup = createServerCleanup({
      cleanupProcesses: async () => {
        stages.push('processes');
        throw limitation;
      },
      stopHeartbeat: () => stages.push('heartbeat-stopped'),
      closeBridge: () => stages.push('bridge-closed'),
      closeServer: async () => {
        stages.push('server-closed');
      },
      terminalize: async () => {
        stages.push('terminalized');
      },
      flushTelemetry: async () => {
        stages.push('telemetry-flushed');
      },
    });
    const exitProcess = vi.fn();
    return { cleanup, exitProcess, limitation, stages };
  }

  it('finalizes IPC and surfaces an unreaped-group limitation to the caller', async () => {
    const { cleanup, limitation, stages } = createUnreapedGroupProbe();

    await expect(cleanup({ kind: 'signal', signal: 'SIGTERM' })).rejects.toBe(limitation);

    expect(stages).toEqual([
      'heartbeat-stopped',
      'processes',
      'bridge-closed',
      'server-closed',
      'terminalized',
      'telemetry-flushed',
    ]);
  });

  it('releases the matching authority only after non-crash final state handling', async () => {
    const stages: string[] = [];
    const releaseAuthority = vi.fn(() => {
      stages.push('authority-released');
      return true;
    });
    const cleanup = createServerCleanup({
      cleanupProcesses: async () => {
        stages.push('processes');
      },
      stopHeartbeat: () => stages.push('heartbeat-stopped'),
      closeBridge: () => stages.push('bridge-closed'),
      closeServer: async () => {
        stages.push('server-closed');
      },
      terminalize: async (termination) => {
        stages.push(`terminalized:${termination.kind}`);
      },
      releaseAuthority,
      flushTelemetry: async () => {
        stages.push('telemetry-flushed');
      },
    });

    await cleanup({ kind: 'exit', exitCode: 0 });

    expect(releaseAuthority).toHaveBeenCalledOnce();
    expect(stages).toEqual([
      'heartbeat-stopped',
      'processes',
      'bridge-closed',
      'server-closed',
      'terminalized:exit',
      'authority-released',
      'telemetry-flushed',
    ]);
  });

  it('leaves the authority receipt as crash evidence for proven-dead takeover', async () => {
    const releaseAuthority = vi.fn(() => true);
    const cleanup = createServerCleanup({
      cleanupProcesses: async () => {},
      stopHeartbeat: () => {},
      closeBridge: () => {},
      closeServer: async () => {},
      terminalize: async () => {},
      releaseAuthority,
      flushTelemetry: async () => {},
    });

    await cleanup({ kind: 'crash', cause: 'uncaught' });

    expect(releaseAuthority).not.toHaveBeenCalled();
  });

  it('exits non-zero when a runner group cannot be reaped, on every later attempt too', async () => {
    const { cleanup, exitProcess, limitation } = createUnreapedGroupProbe();
    const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    const handlers = createServerExitHandlers({ cleanup, exitProcess });

    try {
      await expect(handlers.signal('SIGTERM')).resolves.toBeUndefined();
      await expect(handlers.crash(new Error('boom'))).resolves.toBeUndefined();

      expect(exitProcess.mock.calls).toEqual([[1], [1]]);
      expect(stderr.mock.calls.map(([chunk]) => String(chunk))).toEqual([
        `server-entry: cleanup failed: ${limitation.message}\n`,
        `server-entry: cleanup failed: ${limitation.message}\n`,
      ]);
    } finally {
      stderr.mockRestore();
    }
  });
});
