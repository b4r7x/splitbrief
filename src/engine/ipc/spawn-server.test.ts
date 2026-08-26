import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  mkdirSync,
  rmSync,
  existsSync,
  statSync,
  writeFileSync,
  readFileSync,
  readdirSync,
  mkdtempSync,
  closeSync,
  openSync,
  writeSync,
} from 'node:fs';
import { execSync, execFileSync } from 'node:child_process';
import { basename, join } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer, type Server } from 'node:net';
import { IPC_SOCK_FILE } from '../../core/paths.js';
import { HEARTBEAT_STALENESS_MS } from '../../core/sessions/lockfile-status.js';
import { writeLockfile } from './lockfile.js';
import {
  acceptsDetachedPreparedResult,
  buildServerArgs,
  buildServerArgv,
  publishBootstrapLog,
  resolveEntryPoint,
  spawnServer,
  waitForServerReady,
  type SpawnServerOptions,
} from './spawn-server.js';
import { parseIpcServerArgs, writeIpcServerArgsFile } from './server-args.js';
import {
  createSessionPreparationCandidate,
  prepareNewSession,
  rollbackPreparedSession,
} from '../../core/sessions/prepare.js';
import { transferPreparedSessionToDetached } from '../../core/sessions/detached-handoff.js';
import { makeConfig } from '#testing/helpers/factories/config.js';
import { EventEmitter } from 'node:events';
import type { ChildProcess, spawn as spawnProcess } from 'node:child_process';
import { readActiveRecord } from '../../core/sessions/active-pointer.js';
import { detachedBootstrapRoot, sessionDir } from '../../core/paths.js';

let testDir: string;
let socketServer: Server | null = null;

async function listenOnSocket(sockPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    socketServer = createServer();
    socketServer.once('error', reject);
    socketServer.listen(sockPath, resolve);
  });
}

function closeSocketServer(): Promise<void> {
  return new Promise((resolve) => {
    if (!socketServer) {
      resolve();
      return;
    }
    socketServer.close(() => resolve());
    socketServer = null;
  });
}

function currentProcessStartTimeMs(): number {
  const raw = execSync(`ps -o lstart= -p ${process.pid}`, {
    encoding: 'utf-8',
    stdio: ['pipe', 'pipe', 'pipe'],
  }).trim();
  const parsed = Date.parse(raw);
  return Number.isNaN(parsed) ? Date.now() : parsed;
}

async function writeServerLockfile(
  overrides?: Partial<Parameters<typeof writeLockfile>[1]>,
): Promise<void> {
  const now = Date.now();
  await writeLockfile(testDir, {
    pid: process.pid,
    startTimeMs: currentProcessStartTimeMs(),
    lastAliveMs: now,
    sessionId: basename(testDir),
    mode: 'standard',
    feature: 'test feature',
    authToken: 'test-startup-auth',
    ...overrides,
  });
}

function sessionIdFor(dir: string): string {
  return basename(dir);
}

beforeEach(() => {
  testDir = mkdtempSync('/tmp/sb-spawn-');
});

afterEach(async () => {
  await closeSocketServer();
  if (existsSync(testDir)) rmSync(testDir, { recursive: true, force: true });
});

describe('waitForServerReady', () => {
  it('returns { ok: true } when lockfile is alive and socket accepts connections', async () => {
    await writeServerLockfile();
    await listenOnSocket(join(testDir, IPC_SOCK_FILE));

    const result = await waitForServerReady({
      sessionDir: testDir,
      sessionId: sessionIdFor(testDir),
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.pid).toBe(process.pid);
      expect(result.sessionId).toBe(sessionIdFor(testDir));
    }
  });

  it('returns { ok: false } when lockfile never appears', async () => {
    const result = await waitForServerReady({
      sessionDir: testDir,
      sessionId: sessionIdFor(testDir),
      timeoutMs: 600,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain('timeout');
    }
  });

  it('returns { ok: false } when lockfile heartbeat is stale', async () => {
    await writeServerLockfile({
      lastAliveMs: Date.now() - HEARTBEAT_STALENESS_MS - 1,
    });

    const result = await waitForServerReady({
      sessionDir: testDir,
      sessionId: sessionIdFor(testDir),
      timeoutMs: 600,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain('timeout');
    }
  });

  it('fails fast with the recorded cause and log path when the server exits during startup', async () => {
    await writeServerLockfile({
      exitedAt: Date.now(),
      signal: 'uncaught',
      cause: 'config validation failed',
    });

    const start = Date.now();
    const result = await waitForServerReady({
      sessionDir: testDir,
      sessionId: sessionIdFor(testDir),
      timeoutMs: 5000,
    });
    const elapsed = Date.now() - start;

    expect(result.ok).toBe(false);
    expect(elapsed).toBeLessThan(2000);
    if (!result.ok) {
      expect(result.reason).toContain('config validation failed');
      expect(result.reason).toContain(join(testDir, 'server.log'));
      expect(result.reason).not.toContain('timeout');
    }
  });

  it('falls back to the recorded signal when no cause is present on a startup exit', async () => {
    await writeServerLockfile({
      exitedAt: Date.now(),
      signal: 'SIGTERM',
    });

    const result = await waitForServerReady({
      sessionDir: testDir,
      sessionId: sessionIdFor(testDir),
      timeoutMs: 5000,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain('SIGTERM');
    }
  });

  it('returns { ok: false } when the socket path exceeds the unix-domain byte limit', async () => {
    const longSessionDir = join(tmpdir(), 'd'.repeat(120));
    const candidate = join(longSessionDir, IPC_SOCK_FILE);
    expect(Buffer.byteLength(candidate, 'utf8')).toBeGreaterThan(104);

    const result = await waitForServerReady({
      sessionDir: longSessionDir,
      sessionId: sessionIdFor(longSessionDir),
      timeoutMs: 5000,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain('unix-domain limit');
      expect(result.reason).toContain(candidate);
    }
  });
});

describe('spawnServer', () => {
  it('resolves { ok: false } when the child process emits a spawn error instead of crashing', async () => {
    const savedPath = process.env['PATH'];
    process.env['PATH'] = '';
    try {
      const result = await spawnServer({
        candidate: createSessionPreparationCandidate({
          projectDir: testDir,
          feature: 'test feature',
          persistTranscript: true,
          sessionId: sessionIdFor(testDir),
        }),
        projectDir: testDir,
        feature: 'test feature',
      });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toContain('failed to spawn server');
      }
    } finally {
      process.env['PATH'] = savedPath;
    }
  });
});

// The parent's `--otel-exporter` flag lives only in its argv, so the detached host sees it only
// because spawnServer passes `env: buildServerEnv()` to spawn(), and buildServerEnv translates
// readOtelExporterFromArgv(process.argv) into the child's SPLITBRIEF_OTEL_EXPORTER. This probe drives
// the real buildServerEnv() with the flag in argv, boots OTel from the env it produces (the exact
// channel the spawned child inherits), and reports whether that forwarded exporter recorded a span.
function runArgvForwardingProbe(parentExporterFlag: string[]): string {
  const env = { ...process.env };
  delete env['OTEL_TRACES_EXPORTER'];
  delete env['SPLITBRIEF_OTEL_EXPORTER'];

  const script = `
    import { trace } from '@opentelemetry/api';
    import { bootstrapOtel } from './src/lib/otel.ts';
    import { buildServerEnv } from './src/engine/ipc/spawn-server.ts';

    const childEnv = buildServerEnv();

    // The spawned child never inherits the parent's --otel-exporter argv; it sees the exporter only
    // through the env buildServerEnv() forwards. Drop the flag so the env channel is the sole input.
    process.argv = [process.argv[0], process.argv[1]];
    delete process.env.OTEL_TRACES_EXPORTER;
    delete process.env.SPLITBRIEF_OTEL_EXPORTER;
    if (childEnv.SPLITBRIEF_OTEL_EXPORTER !== undefined) {
      process.env.SPLITBRIEF_OTEL_EXPORTER = childEnv.SPLITBRIEF_OTEL_EXPORTER;
    }

    console.dir = (value) => {
      if (value && typeof value === 'object' && value.name === 'forwarded-span') {
        process.stdout.write('exported:forwarded-span');
      }
    };

    bootstrapOtel();
    trace.getTracer('forwarding').startSpan('forwarded-span').end();
  `;

  return execFileSync(
    process.execPath,
    ['--import', 'tsx', '--eval', script, '--', ...parentExporterFlag],
    { cwd: process.cwd(), env, encoding: 'utf-8' },
  );
}

describe('spawn-server otel forwarding', () => {
  it('does not forward an exporter when the parent argv carries no --otel-exporter flag', () => {
    expect(runArgvForwardingProbe([])).toBe('');
  });

  it('forwards the parent --otel-exporter flag so the detached host exports spans', () => {
    expect(runArgvForwardingProbe(['--otel-exporter=console'])).toBe('exported:forwarded-span');
    expect(runArgvForwardingProbe(['--otel-exporter', 'console'])).toBe('exported:forwarded-span');
  });
});

describe('resolveEntryPoint', () => {
  it('runs the tsx src entry under tsx even when a stale dist build exists', () => {
    const root = join(testDir, 'dev-tree');
    const distEntry = join(root, 'dist', 'engine', 'ipc', 'server-entry.js');
    mkdirSync(join(root, 'dist', 'engine', 'ipc'), { recursive: true });
    writeFileSync(distEntry, '// stale compiled build');
    const moduleDir = join(root, 'src', 'engine', 'ipc');
    const moduleFile = join(moduleDir, 'spawn-server.ts');

    const entry = resolveEntryPoint(moduleDir, moduleFile);

    expect(entry.tsx).toBe(true);
    expect(entry.command).toBe('npx');
    expect(entry.args).toEqual(['tsx', join(root, 'src', 'engine', 'ipc', 'server-entry.ts')]);
  });

  it('runs the compiled dist entry for an installed build when dist exists', () => {
    const root = join(testDir, 'installed');
    const distEntry = join(root, 'dist', 'engine', 'ipc', 'server-entry.js');
    mkdirSync(join(root, 'dist', 'engine', 'ipc'), { recursive: true });
    writeFileSync(distEntry, '// compiled build');
    const moduleDir = join(root, 'dist', 'engine', 'ipc');
    const moduleFile = join(moduleDir, 'spawn-server.js');

    const entry = resolveEntryPoint(moduleDir, moduleFile);

    expect(entry.tsx).toBe(false);
    expect(entry.command).toBe(process.execPath);
    expect(entry.args).toEqual([distEntry]);
  });

  it('resolves the real server-entry under tsx when called with no arguments', () => {
    const expectedEntry = join(process.cwd(), 'src', 'engine', 'ipc', 'server-entry.ts');
    const entry = resolveEntryPoint();

    expect(entry.tsx).toBe(true);
    expect(entry.command).toBe('npx');
    expect(entry.args).toEqual(['tsx', expectedEntry]);
    expect(existsSync(expectedEntry)).toBe(true);
  });
});

describe('server args launch contract', () => {
  it('stores detached launch details in a secure args file', () => {
    const argsFile = writeIpcServerArgsFile({
      bootstrapDir: testDir,
      args: {
        version: 1,
        parentPid: process.pid,
        candidate: {
          version: 1,
          sessionId: 'test-session',
          generation: '12345678-1234-4123-8123-123456789abc',
        },
        projectDir: '/repo',
        feature: 'implement from @file\n\nsecret context',
        overrides: { budget: 4 },
      },
    });

    expect(statSync(argsFile).mode & 0o777).toBe(0o600);
    expect(parseIpcServerArgs(JSON.parse(readFileSync(argsFile, 'utf8')))).toMatchObject({
      candidate: { sessionId: 'test-session' },
      feature: 'implement from @file\n\nsecret context',
      overrides: { budget: 4 },
    });

    const argv = buildServerArgv(['server-entry.js'], argsFile);
    expect(argv.join('\n')).not.toContain('implement from @file');
    expect(argv.join('\n')).not.toContain('secret context');
    expect(argv).toEqual(['server-entry.js', argsFile]);
  });
});

describe('buildServerArgs transport policy', () => {
  const base: SpawnServerOptions = {
    candidate: {
      version: 1,
      sessionId: 's',
      generation: '12345678-1234-4123-8123-123456789abc',
    },
    projectDir: '/repo',
    feature: 'add secret oauth login',
  };

  it('keeps the raw feature in the private bootstrap so the detached planner gets the real input', () => {
    const args = buildServerArgs(base);
    expect(args.feature).toBe('add secret oauth login');
  });

  it('forwards repo runner trust to the detached child', () => {
    expect(buildServerArgs({ ...base, allowRepoRunners: true }).allowRepoRunners).toBe(true);
  });

  it.each([
    ['API-key selectors', { planner: { apiKey: 'env:PLANNER_KEY' } }],
    ['raw runner arguments', { implementer: { args: ['--header', 'secret'] } }],
    ['reviewer API-key selectors', { reviewer: { apiKey: 'env:REVIEWER_KEY' } }],
    ['reviewer raw runner arguments', { reviewer: { args: ['--header', 'secret'] } }],
  ])('rejects detached %s instead of silently persisting or dropping them', (_label, overrides) => {
    expect(() => buildServerArgs({ ...base, overrides })).toThrow(/cannot cross/);
  });
});

function detachedCandidate(projectDir: string, sessionId: string) {
  return createSessionPreparationCandidate({
    projectDir,
    feature: 'detached startup',
    persistTranscript: true,
    sessionId,
  });
}

function prepareDetachedCandidate(
  projectDir: string,
  candidate: ReturnType<typeof detachedCandidate>,
) {
  return prepareNewSession({
    projectDir,
    feature: 'detached startup',
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
    signal: new AbortController().signal,
    candidate,
  });
}

function fakeChild(pid = 4242): ChildProcess {
  const child = new EventEmitter();
  Object.defineProperties(child, {
    pid: { value: pid },
    exitCode: { value: null, writable: true },
    signalCode: { value: null, writable: true },
  });
  Object.assign(child, { unref: () => {} });
  return child as ChildProcess;
}

function fakeSpawn(child: ChildProcess): typeof spawnProcess {
  return (() => child) as typeof spawnProcess;
}

function bootstrapArtifacts(projectDir: string): string[] {
  const root = detachedBootstrapRoot(projectDir);
  return existsSync(root) ? readdirSync(root) : [];
}

describe('detached receipt handoff', () => {
  it('cancellation terminates and waits before rollback without leaving detached artifacts', async () => {
    const candidate = detachedCandidate(testDir, 'cancelled-start');
    const child = fakeChild();
    const cancellation = new AbortController();
    const order: string[] = [];

    const result = await spawnServer(
      {
        candidate,
        projectDir: testDir,
        feature: 'detached startup',
        signal: cancellation.signal,
      },
      {
        spawnChild: fakeSpawn(child),
        waitForPrepared: async ({ signal }) => {
          const prepared = prepareDetachedCandidate(testDir, candidate);
          expect(prepared.kind).toBe('prepared');
          order.push('polling');
          cancellation.abort();
          expect(signal?.aborted).toBe(true);
          return { ok: false, reason: 'detached start cancelled' };
        },
        terminateAndWait: async () => {
          order.push('kill');
          await Promise.resolve();
          order.push('wait');
          return true;
        },
        rollback: (session) => {
          order.push('rollback');
          rollbackPreparedSession(session);
        },
      },
    );

    expect(result).toEqual({ ok: false, reason: 'detached start cancelled' });
    expect(order).toEqual(['polling', 'kill', 'wait', 'rollback']);
    expect(existsSync(sessionDir(testDir, candidate.sessionId))).toBe(false);
    expect(readActiveRecord(testDir)).toBeNull();
    expect(bootstrapArtifacts(testDir)).toEqual([]);
  });

  it('keeps the child log writable at its final session path after handoff cleanup', () => {
    const bootstrapDir = mkdtempSync(join(testDir, 'bootstrap-'));
    const finalDir = join(testDir, 'final-session');
    const bootstrapLog = join(bootstrapDir, 'server.log');
    mkdirSync(finalDir);
    const descriptor = openSync(bootstrapLog, 'a', 0o600);

    try {
      writeSync(descriptor, 'before handoff\n');
      const finalLog = publishBootstrapLog({ bootstrapDir, finalSessionDir: finalDir });
      rmSync(bootstrapDir, { recursive: true, force: true });
      writeSync(descriptor, 'after handoff\n');

      expect(finalLog).toBe(join(finalDir, 'server.log'));
      expect(readFileSync(finalLog, 'utf8')).toBe('before handoff\nafter handoff\n');
    } finally {
      closeSync(descriptor);
    }
  });

  it.each(['pre-directory', 'post-creation', 'log-transfer', 'transfer'] as const)(
    'terminates the child and removes bootstrap and final artifacts on a %s startup failure',
    async (stage) => {
      const candidate = detachedCandidate(testDir, `failure-${stage}`);
      const child = fakeChild();
      const order: string[] = [];
      const result = await spawnServer(
        { candidate, projectDir: testDir, feature: 'detached startup' },
        {
          spawnChild: fakeSpawn(child),
          waitForPrepared: async () => {
            if (stage !== 'pre-directory') {
              const prepared = prepareDetachedCandidate(testDir, candidate);
              expect(prepared.kind).toBe('prepared');
              if (stage === 'log-transfer') {
                writeFileSync(
                  join(sessionDir(testDir, candidate.sessionId), 'server.log'),
                  'conflicting log',
                );
              }
            }
            order.push('failed');
            return stage === 'transfer' || stage === 'log-transfer'
              ? { ok: true, pid: 4242, sessionId: candidate.sessionId, authToken: 'auth' }
              : { ok: false, reason: 'startup failed' };
          },
          terminateAndWait: async () => {
            order.push('kill');
            await Promise.resolve();
            order.push('wait');
            return true;
          },
          ...(stage === 'transfer' && {
            acceptServer: async () => {
              order.push('parent-accept');
              return { ok: true, pid: 4242, sessionId: candidate.sessionId };
            },
            transfer: () => {
              order.push('transfer-failed');
              throw new Error('transfer failed');
            },
          }),
          rollback: (session) => {
            order.push('rollback');
            rollbackPreparedSession(session);
          },
        },
      );

      expect(result.ok).toBe(false);
      expect(order.indexOf('kill')).toBeGreaterThan(order.indexOf('failed'));
      expect(order.indexOf('wait')).toBeGreaterThan(order.indexOf('kill'));
      expect(order.indexOf('rollback')).toBeGreaterThan(order.indexOf('wait'));
      expect(existsSync(sessionDir(testDir, candidate.sessionId))).toBe(false);
      expect(bootstrapArtifacts(testDir)).toEqual([]);
    },
  );

  it('preserves owned state when child termination cannot be confirmed', async () => {
    const candidate = detachedCandidate(testDir, 'unconfirmed-child');
    const child = fakeChild();
    const order: string[] = [];

    const result = await spawnServer(
      { candidate, projectDir: testDir, feature: 'detached startup' },
      {
        spawnChild: fakeSpawn(child),
        waitForPrepared: async () => {
          const prepared = prepareDetachedCandidate(testDir, candidate);
          expect(prepared.kind).toBe('prepared');
          order.push('failed');
          return { ok: false, reason: 'startup rejected' };
        },
        terminateAndWait: async () => {
          order.push('termination-unconfirmed');
          return false;
        },
        rollback: () => {
          order.push('rollback');
        },
      },
    );

    expect(result).toEqual({
      ok: false,
      reason: 'startup rejected; child termination could not be confirmed',
    });
    expect(order).toEqual(['failed', 'termination-unconfirmed']);
    expect(readActiveRecord(testDir)).toEqual({ kind: 'v1', receipt: candidate });
    expect(existsSync(sessionDir(testDir, candidate.sessionId))).toBe(true);
    expect(bootstrapArtifacts(testDir)).not.toEqual([]);
  });

  it('removes the exact candidate session when the child dies after creation before acknowledgement', async () => {
    const candidate = detachedCandidate(testDir, 'dies-before-ack');
    const child = fakeChild();

    const result = await spawnServer(
      { candidate, projectDir: testDir, feature: 'detached startup' },
      {
        spawnChild: fakeSpawn(child),
        waitForPrepared: async () => {
          const prepared = prepareDetachedCandidate(testDir, candidate);
          expect(prepared.kind).toBe('prepared');
          return { ok: false, reason: 'child exited before acknowledgement' };
        },
        terminateAndWait: async () => true,
      },
    );

    expect(result.ok).toBe(false);
    expect(existsSync(sessionDir(testDir, candidate.sessionId))).toBe(false);
  });

  it('uses the detached candidate generation as the initial active receipt and rolls back a pre-ack child death', async () => {
    const candidate = detachedCandidate(testDir, 'candidate-active');
    const child = fakeChild();

    const result = await spawnServer(
      { candidate, projectDir: testDir, feature: 'detached startup' },
      {
        spawnChild: fakeSpawn(child),
        waitForPrepared: async () => {
          const prepared = prepareDetachedCandidate(testDir, candidate);
          expect(prepared).toMatchObject({
            kind: 'prepared',
            session: { ownership: candidate, active: candidate },
          });
          expect(readActiveRecord(testDir)).toEqual({ kind: 'v1', receipt: candidate });
          return { ok: false, reason: 'child died before ack' };
        },
        terminateAndWait: async () => true,
      },
    );

    expect(result.ok).toBe(false);
    expect(readActiveRecord(testDir)).toBeNull();
    expect(existsSync(sessionDir(testDir, candidate.sessionId))).toBe(false);
  });

  it('parent transfers ownership only after exact response and socket acceptance', async () => {
    const candidate = detachedCandidate(testDir, 'parent-release');
    const child = fakeChild();
    const order: string[] = [];
    const result = await spawnServer(
      { candidate, projectDir: testDir, feature: 'detached startup' },
      {
        spawnChild: fakeSpawn(child),
        waitForPrepared: async () => {
          const prepared = prepareDetachedCandidate(testDir, candidate);
          expect(prepared.kind).toBe('prepared');
          order.push('response');
          order.push('socket');
          return { ok: true, pid: 4242, sessionId: candidate.sessionId, authToken: 'auth' };
        },
        acceptServer: async () => {
          order.push('parent-accept');
          return { ok: true, pid: 4242, sessionId: candidate.sessionId };
        },
        transfer: (session) => {
          order.push('parent-transfer');
          transferPreparedSessionToDetached(session);
        },
      },
    );

    expect(result).toEqual({ ok: true, pid: 4242, sessionId: candidate.sessionId });
    expect(order).toEqual(['response', 'socket', 'parent-accept', 'parent-transfer']);
    expect(existsSync(join(sessionDir(testDir, candidate.sessionId), '.prepare-owner.json'))).toBe(
      true,
    );
    expect(
      existsSync(join(sessionDir(testDir, candidate.sessionId), '.detached-handoff.json')),
    ).toBe(true);
  });

  it('keeps parent rollback authority when the acceptance ACK cannot be confirmed', async () => {
    const candidate = detachedCandidate(testDir, 'ack-write-failure');
    const child = fakeChild();
    const order: string[] = [];

    const result = await spawnServer(
      { candidate, projectDir: testDir, feature: 'detached startup' },
      {
        spawnChild: fakeSpawn(child),
        waitForPrepared: async () => {
          const prepared = prepareDetachedCandidate(testDir, candidate);
          expect(prepared.kind).toBe('prepared');
          return { ok: true, pid: 4242, sessionId: candidate.sessionId, authToken: 'auth' };
        },
        acceptServer: async () => {
          order.push('ack-failed');
          return { ok: false, reason: 'parent acceptance ACK was not flushed' };
        },
        transfer: () => {
          order.push('transfer');
        },
        terminateAndWait: async () => {
          order.push('terminate');
          return true;
        },
        rollback: (session) => {
          order.push('rollback');
          rollbackPreparedSession(session);
        },
      },
    );

    expect(result).toEqual({ ok: false, reason: 'parent acceptance ACK was not flushed' });
    expect(order).toEqual(['ack-failed', 'terminate', 'rollback']);
    expect(existsSync(sessionDir(testDir, candidate.sessionId))).toBe(false);
  });

  it('cancels after acceptance and before ownership transfer', async () => {
    const candidate = detachedCandidate(testDir, 'cancel-after-acceptance');
    const child = fakeChild();
    const cancellation = new AbortController();
    const order: string[] = [];

    const result = await spawnServer(
      {
        candidate,
        projectDir: testDir,
        feature: 'detached startup',
        signal: cancellation.signal,
      },
      {
        spawnChild: fakeSpawn(child),
        waitForPrepared: async () => {
          const prepared = prepareDetachedCandidate(testDir, candidate);
          expect(prepared.kind).toBe('prepared');
          return { ok: true, pid: 4242, sessionId: candidate.sessionId, authToken: 'auth' };
        },
        acceptServer: async () => {
          order.push('accepted');
          cancellation.abort();
          return { ok: true, pid: 4242, sessionId: candidate.sessionId };
        },
        transfer: () => {
          order.push('transfer');
        },
        terminateAndWait: async () => {
          order.push('terminate');
          return true;
        },
        rollback: (session) => {
          order.push('rollback');
          rollbackPreparedSession(session);
        },
      },
    );

    expect(result).toEqual({ ok: false, reason: 'detached start cancelled' });
    expect(order).toEqual(['accepted', 'terminate', 'rollback']);
    expect(readActiveRecord(testDir)).toBeNull();
    expect(existsSync(sessionDir(testDir, candidate.sessionId))).toBe(false);
    expect(bootstrapArtifacts(testDir)).toEqual([]);
  });

  it('pre-directory detached failure treats absent candidate rollback as a no-op', async () => {
    const candidate = detachedCandidate(testDir, 'absent-candidate');
    const child = fakeChild();
    const order: string[] = [];

    const result = await spawnServer(
      { candidate, projectDir: testDir, feature: 'detached startup' },
      {
        spawnChild: fakeSpawn(child),
        waitForPrepared: async () => ({ ok: false, reason: 'failed before preparation' }),
        terminateAndWait: async () => {
          order.push('kill');
          await Promise.resolve();
          order.push('wait');
          return true;
        },
        rollback: (session) => {
          order.push('rollback');
          rollbackPreparedSession(session);
        },
      },
    );

    expect(result.ok).toBe(false);
    expect(order).toEqual(['kill', 'wait', 'rollback']);
    expect(existsSync(sessionDir(testDir, candidate.sessionId))).toBe(false);
    expect(bootstrapArtifacts(testDir)).toEqual([]);
  });

  it('removes the bootstrap even when receipt-aware rollback fails', async () => {
    const candidate = detachedCandidate(testDir, 'rollback-failure');
    const child = fakeChild();

    const result = await spawnServer(
      { candidate, projectDir: testDir, feature: 'detached startup' },
      {
        spawnChild: fakeSpawn(child),
        waitForPrepared: async () => ({ ok: false, reason: 'startup rejected' }),
        terminateAndWait: async () => true,
        rollback: () => {
          throw new Error('rollback failed');
        },
      },
    );

    expect(result).toEqual({
      ok: false,
      reason: 'startup rejected; startup rollback failed',
    });
    expect(bootstrapArtifacts(testDir)).toEqual([]);
  });
});

describe('acceptsDetachedPreparedResult', () => {
  it('accepts a response matching the candidate receipt and the spawned child pid', () => {
    const candidate = detachedCandidate(testDir, 'accepts-match');

    expect(
      acceptsDetachedPreparedResult({
        result: {
          version: 1,
          kind: 'prepared',
          sessionId: candidate.sessionId,
          ownership: candidate,
          active: candidate,
          pid: 4242,
        },
        candidate,
        childPid: 4242,
      }),
    ).toBe(true);
  });

  it('rejects a response reporting a pid other than the spawned child', () => {
    const candidate = detachedCandidate(testDir, 'rejects-pid');

    expect(
      acceptsDetachedPreparedResult({
        result: {
          version: 1,
          kind: 'prepared',
          sessionId: candidate.sessionId,
          ownership: candidate,
          active: candidate,
          pid: 4242,
        },
        candidate,
        childPid: 4243,
      }),
    ).toBe(false);
  });

  it('rejects a response whose ownership generation is not the candidate generation', () => {
    const candidate = detachedCandidate(testDir, 'rejects-generation');
    const stale = { ...candidate, generation: '12345678-1234-4123-8123-123456789abc' };

    expect(
      acceptsDetachedPreparedResult({
        result: {
          version: 1,
          kind: 'prepared',
          sessionId: candidate.sessionId,
          ownership: stale,
          active: candidate,
          pid: 4242,
        },
        candidate,
        childPid: 4242,
      }),
    ).toBe(false);
  });
});
