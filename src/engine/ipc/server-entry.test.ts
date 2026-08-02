import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { formatConfigLoaderDiagnostic } from '../../core/config/load/io.js';
import type { ConfigLoaderDiagnostic } from '../../core/config/load/io.js';
import { sessionDir } from '../../core/paths.js';
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
  createServerProcessCleanup,
  emitConfigWarnings,
  getArgv,
  writeStartupLockfile,
} from './server-entry.js';
import { writeIpcServerArgsFile } from './server-args.js';

describe('getArgv', () => {
  let tmp: string;
  let projectDir: string;
  const sessionId = 'session-1';

  const validArgs = (): IpcServerArgs => ({
    sessionId,
    projectDir,
    feature: 'add login',
    mode: 'standard',
    configPath: '/tmp/splitbrief.yaml',
    overrides: {},
  });

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'server-entry-'));
    projectDir = tmp;
    mkdirSync(sessionDir(projectDir, sessionId), { recursive: true });
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
    const argsFile = writeIpcServerArgsFile(sessionDir(projectDir, sessionId), validArgs());

    const result = getArgv(['node', 'server-entry.js', argsFile]);

    expect(result).toMatchObject({
      sessionId,
      projectDir,
      feature: 'add login',
      mode: 'standard',
      configPath: '/tmp/splitbrief.yaml',
    });
  });

  it('exits when no args-file positional is provided', () => {
    expect(() => getArgv(['node', 'server-entry.js'])).toThrow('process.exit(1)');
  });

  it('exits when the args file cannot be read', () => {
    const missing = join(sessionDir(projectDir, sessionId), 'server-args.json');

    expect(() => getArgv(['node', 'server-entry.js', missing])).toThrow('process.exit(1)');
  });
});

describe('emitConfigWarnings', () => {
  let stderrChunks: string[];

  beforeEach(() => {
    stderrChunks = [];
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
      stderrChunks.push(String(chunk));
      return true;
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('writes each effective-config warning to stderr so the detached server log surfaces it', () => {
    emitConfigWarnings([
      {
        source: 'loader',
        diagnostic: { kind: 'config-file-permissions', path: '/tmp/.splitbrief/config.yaml' },
      },
      { source: 'validation', message: 'budget override exceeds the configured ceiling.' },
    ]);

    const written = stderrChunks.join('');
    expect(written).toContain('⚠ Config file /tmp/.splitbrief/config.yaml has overly permissive');
    expect(written).toContain('⚠ budget override exceeds the configured ceiling.');
  });

  it('prints matching loader and validation warnings once', () => {
    const diagnostic = {
      kind: 'config-file-permissions',
      path: '/tmp/.splitbrief/config.yaml',
    } satisfies ConfigLoaderDiagnostic;
    const message = formatConfigLoaderDiagnostic(diagnostic);

    emitConfigWarnings([
      { source: 'loader', diagnostic },
      { source: 'validation', message },
    ]);

    expect(stderrChunks.filter((chunk) => chunk.includes(message))).toHaveLength(1);
  });

  it('writes nothing when there are no warnings', () => {
    emitConfigWarnings([]);

    expect(stderrChunks.join('')).toBe('');
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
      sessionId: 'probe',
      projectDir,
      feature: 'probe',
      mode: 'standard',
      configPath: join(projectDir, 'splitbrief.yaml'),
      overrides: {},
    };

    // The ConsoleSpanExporter that bootstrapOtel() may register writes spans through console.dir;
    // silence it so this probe's stdout carries only the recording verdict.
    console.dir = () => {};

    // main() is async; bootstrapOtel() is its synchronous first statement, so it runs before the
    // first await returns control here. Sample the provider before the heavy startup proceeds, then
    // exit so the IPC server / workflow loop never starts.
    void main(argv, join(projectDir, 'session'));
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
      sessionId: basename(testDir),
      projectDir: testDir,
      feature: 'add secret oauth login',
      mode: 'standard',
      configPath: join(testDir, 'config.yaml'),
      overrides: {},
      ...overrides,
    };
  }

  it('redacts the lockfile feature `splitbrief ps` prints under persistTranscript:false', async () => {
    await writeStartupLockfile(testDir, makeArgv({ persistTranscript: false }));

    const lock = await readLockfile(testDir);
    expect(lock?.feature).toBe(TRANSCRIPT_OMITTED_MESSAGE);
    expect(lock?.feature).not.toBe('add secret oauth login');
  });

  it('keeps the raw lockfile feature under persistTranscript:true', async () => {
    await writeStartupLockfile(testDir, makeArgv({ persistTranscript: true }));

    const lock = await readLockfile(testDir);
    expect(lock?.feature).toBe('add secret oauth login');
  });

  it('keeps the raw lockfile feature when persistTranscript is unset', async () => {
    await writeStartupLockfile(testDir, makeArgv({}));

    const lock = await readLockfile(testDir);
    expect(lock?.feature).toBe('add secret oauth login');
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
