import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { formatConfigLoaderDiagnostic } from '../../core/config/load/io.js';
import type { ConfigLoaderDiagnostic } from '../../core/config/load/io.js';
import { sessionDir } from '../../core/paths.js';
import { TRANSCRIPT_OMITTED_MESSAGE } from '../../core/transcript-policy.js';
import { readLockfile } from './lockfile.js';
import type { IpcServerArgs } from './server-args.js';
import { emitConfigWarnings, getArgv, writeStartupLockfile } from './server-entry.js';
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
    configPath: '/tmp/diptych.yaml',
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
      configPath: '/tmp/diptych.yaml',
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
        diagnostic: { kind: 'config-migration', code: 'deprecated-v2' },
      },
      { source: 'validation', message: 'budget override exceeds the configured ceiling.' },
    ]);

    const written = stderrChunks.join('');
    expect(written).toContain('⚠ config.version 2 is deprecated; diptych migrated it in memory.');
    expect(written).toContain('⚠ budget override exceeds the configured ceiling.');
  });

  it('prints matching loader and validation warnings once', () => {
    const diagnostic = {
      kind: 'config-migration',
      code: 'deprecated-v2',
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
// exporter on DIPTYCH_OTEL_EXPORTER (the env channel spawn-server forwards into), then samples
// whether main()'s bootstrap left a recording provider registered before bailing out of startup.
function runDetachedHostOtelProbe(forwardedExporter: string | undefined): string {
  const env = { ...process.env };
  delete env['OTEL_TRACES_EXPORTER'];
  delete env['DIPTYCH_OTEL_EXPORTER'];
  if (forwardedExporter !== undefined) env['DIPTYCH_OTEL_EXPORTER'] = forwardedExporter;

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
      configPath: join(projectDir, 'diptych.yaml'),
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

  it('redacts the lockfile feature `diptych ps` prints under persistTranscript:false', async () => {
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
