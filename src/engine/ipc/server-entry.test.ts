import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { sessionDir } from '../../core/paths.js';
import { readActive } from '../../core/sessions/active-pointer.js';
import {
  acceptDetachedSessionHandoff,
  settleDetachedSessionHandoff,
} from '../../core/sessions/detached-handoff.js';
import { prepareNewSession } from '../../core/sessions/prepare.js';
import { TRANSCRIPT_OMITTED_MESSAGE } from '../../core/transcript-policy.js';
import { readLockfile } from './lockfile.js';
import {
  killAllProcesses,
  registerProcess,
  unregisterProcess,
} from '../../lib/process/registry.js';
import { processError } from '../../lib/process/errors.js';
import type { IpcServerArgs } from './server-args.js';
import {
  createServerCleanup,
  createServerExitHandlers,
  createParentAcceptanceBarrier,
  createServerProcessCleanup,
  getArgv,
  main,
  writeStartupLockfile,
} from './server-entry.js';
import { writeIpcServerArgsFile } from './server-args.js';
import { makeConfig } from '#testing/helpers/factories/config.js';
import { makeSummary } from '#testing/helpers/factories/summary.js';
import type { PreparedExecution } from '../runners/prepared-execution.js';
import type { IpcServer } from './server.js';
import type { StateAuthorityReceipt } from '../../core/state/types.js';

describe('getArgv', () => {
  let tmp: string;
  let projectDir: string;
  let bootstrapDir: string;
  const sessionId = 'session-1';

  const validArgs = (): IpcServerArgs => ({
    version: 1,
    parentPid: process.pid,
    candidate: {
      version: 1,
      sessionId,
      generation: '12345678-1234-4123-8123-123456789abc',
    },
    projectDir,
    feature: 'add login',
    overrides: {},
  });

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'server-entry-'));
    projectDir = tmp;
    bootstrapDir = join(projectDir, '.splitbrief', 'bootstrap', 'server-test');
    mkdirSync(bootstrapDir, { recursive: true });
    vi.spyOn(process, 'exit').mockImplementation((code) => {
      throw new Error(`process.exit(${typeof code === 'number' ? code : 0})`);
    });
    vi.spyOn(process.stderr, 'write').mockReturnValue(true);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(tmp, { recursive: true, force: true });
  });

  it('resolves the single args-file positional into parsed server args', () => {
    const argsFile = writeIpcServerArgsFile({ bootstrapDir, args: validArgs() });

    const result = getArgv(['node', 'server-entry.js', argsFile]);

    expect(result.args).toMatchObject({
      candidate: { sessionId },
      projectDir,
      feature: 'add login',
    });
    expect(result.bootstrapDir).toBe(bootstrapDir);
    expect(existsSync(argsFile)).toBe(false);
  });

  it('exits when no args-file positional is provided', () => {
    expect(() => getArgv(['node', 'server-entry.js'])).toThrow('process.exit(1)');
  });

  it('exits when the args file cannot be read', () => {
    const missing = join(bootstrapDir, 'server-args.json');

    expect(() => getArgv(['node', 'server-entry.js', missing])).toThrow('process.exit(1)');
  });
});

describe('detached parent acceptance barrier', () => {
  it('fails promptly when the parent process dies before acceptance', async () => {
    const barrier = createParentAcceptanceBarrier({
      candidate: {
        version: 1,
        sessionId: 'parent-died',
        generation: '12345678-1234-4123-8123-123456789abc',
      },
      parentPid: 99_999_999,
      childPid: process.pid,
      timeoutMs: 5_000,
      acceptHandoff: () => false,
      settleHandoff: () => 'rolled-back',
    });

    await expect(barrier.wait()).rejects.toMatchObject({ kind: 'detached-parent-exited' });
  });

  it('does not treat the socket ACK as authoritative when the parent dies before handoff', async () => {
    const candidate = {
      version: 1 as const,
      sessionId: 'handoff-parent-exit',
      generation: '12345678-1234-4123-8123-123456789abc',
    };
    const barrier = createParentAcceptanceBarrier({
      candidate,
      parentPid: 99_999_999,
      childPid: process.pid,
      timeoutMs: 1_000,
      acceptHandoff: () => false,
      settleHandoff: () => 'rolled-back',
    });

    expect(barrier.accept({ ...candidate, childPid: process.pid })).toBe(true);
    await expect(barrier.wait()).rejects.toMatchObject({
      kind: 'detached-parent-exited',
    });
  });

  it('closes the barrier after timing out before socket acceptance', async () => {
    const candidate = {
      version: 1 as const,
      sessionId: 'acceptance-timeout',
      generation: '12345678-1234-4123-8123-123456789abc',
    };
    const barrier = createParentAcceptanceBarrier({
      candidate,
      parentPid: process.pid,
      childPid: process.pid,
      timeoutMs: 0,
      acceptHandoff: () => false,
      settleHandoff: () => 'rolled-back',
    });

    await expect(barrier.wait()).rejects.toMatchObject({
      kind: 'detached-parent-acceptance-timeout',
    });
    expect(barrier.accept({ ...candidate, childPid: process.pid })).toBe(false);
  });

  it('accepts a durable handoff even when the parent exits immediately afterward', async () => {
    const candidate = {
      version: 1 as const,
      sessionId: 'handoff-before-parent-exit',
      generation: '12345678-1234-4123-8123-123456789abc',
    };
    const barrier = createParentAcceptanceBarrier({
      candidate,
      parentPid: 99_999_999,
      childPid: process.pid,
      timeoutMs: 1_000,
      acceptHandoff: () => true,
      settleHandoff: () => 'accepted',
    });

    expect(barrier.accept({ ...candidate, childPid: process.pid })).toBe(true);
    await expect(barrier.wait()).resolves.toBeUndefined();
  });

  it('rejects an ACK that arrives after the deadline before the event-loop poll runs', async () => {
    const candidate = {
      version: 1 as const,
      sessionId: 'late-acceptance',
      generation: '12345678-1234-4123-8123-123456789abc',
    };
    const barrier = createParentAcceptanceBarrier({
      candidate,
      parentPid: process.pid,
      childPid: process.pid,
      timeoutMs: 1,
      acceptHandoff: () => false,
      settleHandoff: () => 'rolled-back',
    });
    const waiting = barrier.wait();
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);

    expect(barrier.accept({ ...candidate, childPid: process.pid })).toBe(false);
    await expect(waiting).rejects.toMatchObject({ kind: 'detached-parent-acceptance-timeout' });
  });

  it('bounds the post-ACK wait and rolls back before rejecting', async () => {
    const projectDir = mkdtempSync(join(tmpdir(), 'server-entry-handoff-timeout-'));
    const candidate = {
      version: 1 as const,
      sessionId: '2026-08-04-handoff-timeout',
      generation: '12345678-1234-4123-8123-123456789abc',
    };
    const prepared = prepareNewSession({
      projectDir,
      feature: 'bounded detached handoff',
      config: makeConfig(),
      report: {
        generatedAt: '2026-08-04T00:00:00.000Z',
        projectDir,
        status: 'ready',
        counts: { ok: 1, info: 0, warning: 0, blocker: 0 },
        nextAction: { kind: 'continue', label: 'Continue', reason: 'Ready' },
        sections: [],
        metadata: {},
      },
      candidate,
    });
    expect(prepared.kind).toBe('prepared');
    if (prepared.kind !== 'prepared') return;
    let ran = false;
    const barrier = createParentAcceptanceBarrier({
      candidate,
      parentPid: process.pid,
      childPid: process.pid,
      timeoutMs: 1,
      acceptHandoff: () => acceptDetachedSessionHandoff(prepared.session),
      settleHandoff: () => settleDetachedSessionHandoff(prepared.session),
    });

    expect(barrier.accept({ ...candidate, childPid: process.pid })).toBe(true);
    const guardedRun = barrier.wait().then(() => {
      ran = true;
    });

    await expect(guardedRun).rejects.toMatchObject({ kind: 'detached-parent-acceptance-timeout' });
    expect(ran).toBe(false);
    expect(existsSync(sessionDir(projectDir, candidate.sessionId))).toBe(false);
    expect(readActive(projectDir)).toBeNull();
    rmSync(projectDir, { recursive: true, force: true });
  });
});

// The detached `start --detach` host runs in a process spawned by spawn-server.ts; main() must call
// bootstrapOtel() first or every span is a NonRecordingSpan (the original F-540 defect). This probe
// invokes the real main() — bootstrapOtel() runs synchronously before main's first await — with the
// exporter on SPLITBRIEF_OTEL_EXPORTER (the env channel spawn-server forwards into), then samples
// whether main()'s bootstrap left a recording provider registered before bailing out of startup.
function runDetachedHostOtelProbe(forwardedExporter: string | undefined): string {
  const env = { ...process.env };
  delete env['OTEL_TRACES_EXPORTER'];
  delete env['SPLITBRIEF_OTEL_EXPORTER'];
  if (forwardedExporter !== undefined) env['SPLITBRIEF_OTEL_EXPORTER'] = forwardedExporter;

  const script = `
    import { mkdtempSync } from 'node:fs';
    import { tmpdir } from 'node:os';
    import { join } from 'node:path';
    import { trace } from '@opentelemetry/api';
    import { main } from './src/engine/ipc/server-entry.ts';

    const projectDir = mkdtempSync(join(tmpdir(), 'server-entry-probe-'));
    const argv = {
      version: 1,
      parentPid: process.pid,
      candidate: {
        version: 1,
        sessionId: 'probe',
        generation: '12345678-1234-4123-8123-123456789abc',
      },
      projectDir,
      feature: 'probe',
      overrides: {},
    };

    // The ConsoleSpanExporter that bootstrapOtel() may register writes spans through console.dir;
    // silence it so this probe's stdout carries only the recording verdict.
    console.dir = () => {};

    // main() is async; bootstrapOtel() is its synchronous first statement, so it runs before the
    // first await returns control here. Sample the provider before the heavy startup proceeds, then
    // exit so the IPC server / workflow loop never starts.
    void main({ argv, bootstrapDir: join(projectDir, 'bootstrap') });
    const span = trace.getTracer('detached-host').startSpan('detached-span');
    process.stdout.write(span.isRecording() ? 'recording' : 'nonrecording');
    span.end();
    process.exit(0);
  `;

  return execFileSync(process.execPath, ['--import', 'tsx', '--eval', script], {
    cwd: process.cwd(),
    env,
    encoding: 'utf-8',
  });
}

describe('detached host OTel bootstrap', () => {
  it('registers a no-op provider when no exporter is forwarded', () => {
    expect(runDetachedHostOtelProbe(undefined)).toBe('nonrecording');
  });

  it('registers a recording provider when main() boots with a forwarded exporter', () => {
    expect(runDetachedHostOtelProbe('console')).toBe('recording');
  });
});

describe('writeStartupLockfile ps-facing redaction', () => {
  let testDir: string;

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), 'server-entry-lockfile-'));
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  function makeArgv(overrides: Partial<IpcServerArgs>): IpcServerArgs {
    return {
      version: 1,
      parentPid: process.pid,
      candidate: {
        version: 1,
        sessionId: basename(testDir),
        generation: '12345678-1234-4123-8123-123456789abc',
      },
      projectDir: testDir,
      feature: 'add secret oauth login',
      overrides: {},
      ...overrides,
    };
  }

  it('redacts the lockfile feature `splitbrief ps` prints under persistTranscript:false', async () => {
    await writeStartupLockfile(testDir, {
      argv: makeArgv({}),
      mode: 'standard',
      persistTranscript: false,
    });

    const lock = await readLockfile(testDir);
    expect(lock?.feature).toBe(TRANSCRIPT_OMITTED_MESSAGE);
  });

  it('keeps the raw lockfile feature under persistTranscript:true', async () => {
    await writeStartupLockfile(testDir, {
      argv: makeArgv({}),
      mode: 'standard',
      persistTranscript: true,
    });

    const lock = await readLockfile(testDir);
    expect(lock?.feature).toBe('add secret oauth login');
  });

  it('writes the session identity, mode and a fresh auth token to the lockfile', async () => {
    const written = await writeStartupLockfile(testDir, {
      argv: makeArgv({}),
      mode: 'standard',
      persistTranscript: true,
    });

    const lock = await readLockfile(testDir);
    expect(lock?.sessionId).toBe(basename(testDir));
    expect(lock?.mode).toBe('standard');
    expect(lock?.authToken).toMatch(/^[0-9a-f]{64}$/);
    expect(lock?.authToken).toBe(written.authToken);
  });
});

describe('detached preparation handoff', () => {
  it('detached child prepares before publishing final session artifacts', async () => {
    const projectDir = mkdtempSync(join(tmpdir(), 'server-entry-prepare-'));
    const bootstrapDir = join(projectDir, '.splitbrief', 'bootstrap', 'server-test');
    const candidate = {
      version: 1 as const,
      sessionId: 'detached-prepared',
      generation: '12345678-1234-4123-8123-123456789abc',
    };
    const argv: IpcServerArgs = {
      version: 1,
      parentPid: process.pid,
      candidate,
      projectDir,
      feature: 'prepare first',
      overrides: {},
    };
    const prepared: PreparedExecution = {
      purpose: 'new-workflow',
      config: makeConfig(),
      preparationId: 'prepared-in-child',
      report: {
        generatedAt: '2026-08-04T00:00:00.000Z',
        projectDir,
        status: 'ready',
        counts: { ok: 1, info: 0, warning: 0, blocker: 0 },
        nextAction: { kind: 'continue', label: 'Continue', reason: 'Ready' },
        sections: [],
        metadata: {},
      },
      gates: [],
      session: {
        kind: 'new',
        ref: { projectDir, sessionId: candidate.sessionId },
        ownership: candidate,
        active: candidate,
      },
      runtime: {
        feature: argv.feature,
        allowRepoRunners: false,
        allowHooks: false,
      },
    };
    const authorityReceipt: StateAuthorityReceipt = {
      kind: 'usable',
      sessionId: candidate.sessionId,
      ownerId: 'detached-owner',
      pid: process.pid,
      processStart: '1',
      runId: 'detached-run',
      acquisitionId: 'detached-acquisition',
      fence: 1,
      stateRevision: 1,
      stateDigest: '0'.repeat(64),
    };
    const order: string[] = [];
    const server: IpcServer = {
      sockPath: join(sessionDir(projectDir, candidate.sessionId), 'ipc.sock'),
      requestClientPrompt: async () => {
        throw new Error('not used');
      },
      close: async () => {
        order.push('close');
      },
    };
    mkdirSync(bootstrapDir, { recursive: true });

    try {
      let acceptParent:
        | ((acceptance: {
            version: 1;
            sessionId: string;
            generation: string;
            childPid: number;
          }) => boolean)
        | undefined;
      let handedOff = false;
      const mainPromise = main({
        argv,
        bootstrapDir,
        cleanupProcesses: async () => {},
        dependencies: {
          prepare: async () => {
            order.push('prepare');
            mkdirSync(sessionDir(projectDir, candidate.sessionId), { recursive: true });
            return { kind: 'prepared', execution: prepared };
          },
          acquireAuthority: () => {
            order.push('authority');
            return { kind: 'fenced', receipt: authorityReceipt, promotedFromVersion: null };
          },
          hydrateState: () => {
            order.push('hydrate');
            return { kind: 'missing' };
          },
          assertAuthority: () => {},
          releaseAuthority: () => true,
          startServer: async (options) => {
            order.push('socket');
            acceptParent = options.onParentAccept;
            return server;
          },
          writePreparedResult: ({ result }) => {
            order.push('publish');
            expect(result.ownership).toEqual(candidate);
            expect(result.active).toEqual(candidate);
            return join(bootstrapDir, 'server-result.json');
          },
          runLoop: async (ctx) => {
            order.push('run');
            expect(ctx.prepared).toBe(prepared);
            return makeSummary({ totalTasks: 0 });
          },
          acceptHandoff: () => {
            if (!handedOff) return false;
            order.push('handoff-accepted');
            return true;
          },
          settleHandoff: () => (handedOff ? 'accepted' : 'rolled-back'),
        },
      });

      await vi.waitFor(() =>
        expect(order).toEqual(['prepare', 'authority', 'hydrate', 'socket', 'publish']),
      );
      expect(order).not.toContain('run');
      expect(
        acceptParent?.({
          ...candidate,
          generation: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
          childPid: process.pid,
        }),
      ).toBe(false);
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(order).not.toContain('run');
      expect(acceptParent?.({ ...candidate, childPid: process.pid })).toBe(true);
      await new Promise((resolve) => setTimeout(resolve, 150));
      expect(order).not.toContain('run');
      handedOff = true;
      await mainPromise;

      expect(order.slice(0, 5)).toEqual(['prepare', 'authority', 'hydrate', 'socket', 'publish']);
      expect(order).toContain('handoff-accepted');
      expect(order).toContain('run');
    } finally {
      rmSync(projectDir, { recursive: true, force: true });
    }
  });
});

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
