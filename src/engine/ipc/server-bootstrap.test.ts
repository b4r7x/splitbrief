import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TRANSCRIPT_OMITTED_MESSAGE } from '../../core/transcript-policy.js';
import { readLockfile } from './lockfile.js';
import { writeIpcServerArgsFile, type IpcServerArgs } from './server-args.js';
import { getArgv, writeStartupLockfile } from './server-bootstrap.js';

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
