import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync, existsSync, statSync, writeFileSync, readFileSync } from 'node:fs';
import { execSync, execFileSync } from 'node:child_process';
import { basename, join } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer, type Server } from 'node:net';
import { IPC_SOCK_FILE } from '../../core/paths.js';
import { HEARTBEAT_STALENESS_MS } from '../../core/sessions/lockfile-status.js';
import { writeLockfile } from './lockfile.js';
import {
  buildServerArgs,
  buildServerArgv,
  resolveEntryPoint,
  spawnServer,
  waitForServerReady,
  type SpawnServerOptions,
} from './spawn-server.js';
import { parseIpcServerArgs, writeIpcServerArgsFile } from './server-args.js';
import { TRANSCRIPT_OMITTED_MESSAGE } from '../../core/transcript-policy.js';
import { featureForTranscriptPolicy } from '../../core/sessions/lifecycle.js';

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
    ...overrides,
  });
}

function sessionIdFor(dir: string): string {
  return basename(dir);
}

beforeEach(() => {
  testDir = join(tmpdir(), `spawn-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(testDir, { recursive: true });
});

afterEach(async () => {
  await closeSocketServer();
  if (existsSync(testDir)) rmSync(testDir, { recursive: true, force: true });
});

describe('waitForServerReady', () => {
  it('returns { ok: true } when lockfile is alive and socket accepts connections', async () => {
    await writeServerLockfile();
    await listenOnSocket(join(testDir, IPC_SOCK_FILE));

    const result = await waitForServerReady(testDir, sessionIdFor(testDir));

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.pid).toBe(process.pid);
      expect(result.sessionId).toBe(sessionIdFor(testDir));
    }
  });

  it('returns { ok: false } when lockfile never appears', async () => {
    const result = await waitForServerReady(testDir, sessionIdFor(testDir), 600);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain('timeout');
    }
  });

  it('returns { ok: false } when lockfile heartbeat is stale', async () => {
    await writeServerLockfile({
      lastAliveMs: Date.now() - HEARTBEAT_STALENESS_MS - 1,
    });

    const result = await waitForServerReady(testDir, sessionIdFor(testDir), 600);

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
    const result = await waitForServerReady(testDir, sessionIdFor(testDir), 5000);
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

    const result = await waitForServerReady(testDir, sessionIdFor(testDir), 5000);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain('SIGTERM');
    }
  });

  it('returns { ok: false } when the socket path exceeds the unix-domain byte limit', async () => {
    const longSessionDir = join(tmpdir(), 'd'.repeat(120));
    const candidate = join(longSessionDir, IPC_SOCK_FILE);
    expect(Buffer.byteLength(candidate, 'utf8')).toBeGreaterThan(104);

    const result = await waitForServerReady(longSessionDir, sessionIdFor(longSessionDir), 5000);

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
        sessionDir: testDir,
        sessionId: sessionIdFor(testDir),
        projectDir: testDir,
        feature: 'test feature',
        mode: 'standard',
        configPath: join(testDir, 'config.yaml'),
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
// readOtelExporterFromArgv(process.argv) into the child's DIPTYCH_OTEL_EXPORTER. This probe drives
// the real buildServerEnv() with the flag in argv, boots OTel from the env it produces (the exact
// channel the spawned child inherits), and reports whether that forwarded exporter recorded a span.
function runArgvForwardingProbe(parentExporterFlag: string[]): string {
  const env = { ...process.env };
  delete env['OTEL_TRACES_EXPORTER'];
  delete env['DIPTYCH_OTEL_EXPORTER'];

  const script = `
    import { trace } from '@opentelemetry/api';
    import { bootstrapOtel } from './src/lib/otel.ts';
    import { buildServerEnv } from './src/engine/ipc/spawn-server.ts';

    const childEnv = buildServerEnv();

    // The spawned child never inherits the parent's --otel-exporter argv; it sees the exporter only
    // through the env buildServerEnv() forwards. Drop the flag so the env channel is the sole input.
    process.argv = [process.argv[0], process.argv[1]];
    delete process.env.OTEL_TRACES_EXPORTER;
    delete process.env.DIPTYCH_OTEL_EXPORTER;
    if (childEnv.DIPTYCH_OTEL_EXPORTER !== undefined) {
      process.env.DIPTYCH_OTEL_EXPORTER = childEnv.DIPTYCH_OTEL_EXPORTER;
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
    const argsFile = writeIpcServerArgsFile(testDir, {
      sessionId: 'test-session',
      projectDir: '/repo',
      feature: 'implement from @file\n\nsecret context',
      mode: 'standard',
      configPath: '/repo/.diptych/config.yaml',
      overrides: { budget: 4 },
    });

    expect(statSync(argsFile).mode & 0o777).toBe(0o600);
    expect(parseIpcServerArgs(JSON.parse(readFileSync(argsFile, 'utf8')))).toMatchObject({
      sessionId: 'test-session',
      feature: 'implement from @file\n\nsecret context',
      overrides: { budget: 4 },
    });

    const argv = buildServerArgv(['server-entry.js'], argsFile);
    expect(argv.join('\n')).not.toContain('implement from @file');
    expect(argv.join('\n')).not.toContain('secret context');
    expect(argv).toEqual(['server-entry.js', argsFile]);
  });
});

describe('buildServerArgs transcript policy', () => {
  const base: SpawnServerOptions = {
    sessionDir: '/repo/.diptych/sessions/s',
    sessionId: 's',
    projectDir: '/repo',
    feature: 'add secret oauth login',
    mode: 'standard',
    configPath: '/repo/.diptych/config.yaml',
  };

  it('keeps the raw feature under persistTranscript:false so the detached planner gets the real input', () => {
    const args = buildServerArgs({ ...base, persistTranscript: false });
    expect(args.feature).toBe('add secret oauth login');
  });

  it('forwards the transcript policy so the child can redact the ps-facing lockfile', () => {
    expect(buildServerArgs({ ...base, persistTranscript: false }).persistTranscript).toBe(false);
    expect(buildServerArgs({ ...base, persistTranscript: true }).persistTranscript).toBe(true);
  });

  it('forwards repo runner trust to the detached child', () => {
    expect(buildServerArgs({ ...base, allowRepoRunners: true }).allowRepoRunners).toBe(true);
  });

  it('redacting the forwarded feature with its policy yields the ps-facing omission', () => {
    const args = buildServerArgs({ ...base, persistTranscript: false });
    expect(featureForTranscriptPolicy(args.feature, args.persistTranscript ?? true)).toBe(
      TRANSCRIPT_OMITTED_MESSAGE,
    );
  });

  it('keeps the raw feature when persistTranscript is true', () => {
    const args = buildServerArgs({ ...base, persistTranscript: true });
    expect(args.feature).toBe('add secret oauth login');
  });

  it('omits the policy and persists the raw feature when persistTranscript is unset', () => {
    const args = buildServerArgs(base);
    expect(args.feature).toBe('add secret oauth login');
    expect(args.persistTranscript).toBeUndefined();
  });
});
