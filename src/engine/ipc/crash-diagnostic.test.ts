import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeFile, mkdir, rm } from 'node:fs/promises';
import type { ServerStatus } from './lockfile.js';
import { buildCrashDiagnostic, formatCrashDiagnostic, showCrashDiagnostic, waitForCrashDiagnosticOption } from './crash-diagnostic.js';

const BASE_STATUS_CRASHED: ServerStatus = {
  alive: false,
  crashed: true,
  data: {
    version: 1,
    pid: 12345,
    startTimeMs: 1745668330000,
    lastAliveMs: 1745669242000,
    sessionId: 'abc123',
    mode: 'standard',
    feature: 'test feature',
    signal: 'SIGKILL',
    cause: 'OOM',
  },
};

const BASE_STATUS_EXITED: ServerStatus = {
  alive: false,
  crashed: false,
  data: {
    version: 1,
    pid: 99999,
    startTimeMs: 1745668330000,
    lastAliveMs: 1745669242000,
    sessionId: 'xyz789',
    mode: 'quick',
    feature: 'done feature',
    exitedAt: 1745669300000,
    exitCode: 0,
  },
};

const NULL_STATUS: ServerStatus = {
  alive: false,
  crashed: false,
  data: null,
};

describe('buildCrashDiagnostic', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = join(tmpdir(), `crash-diag-test-${Date.now()}`);
    await mkdir(tmpDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('returns null-filled fields when status.data is null', async () => {
    const diag = await buildCrashDiagnostic(tmpDir, NULL_STATUS);
    expect(diag.pid).toBeNull();
    expect(diag.startedAt).toBeNull();
    expect(diag.lastAliveAt).toBeNull();
    expect(diag.exitedAt).toBeNull();
    expect(diag.signal).toBeNull();
    expect(diag.exitCode).toBeNull();
    expect(diag.cause).toBeNull();
    expect(diag.status).toBe('exited');
  });

  it('extracts correct fields from valid LockfileData (crashed)', async () => {
    const diag = await buildCrashDiagnostic(tmpDir, BASE_STATUS_CRASHED);
    expect(diag.sessionId).toBe('abc123');
    expect(diag.pid).toBe(12345);
    expect(diag.startedAt).toBe(1745668330000);
    expect(diag.lastAliveAt).toBe(1745669242000);
    expect(diag.signal).toBe('SIGKILL');
    expect(diag.cause).toBe('OOM');
    expect(diag.status).toBe('crashed');
    expect(diag.exitCode).toBeNull();
  });

  it('extracts correct fields from valid LockfileData (exited)', async () => {
    const diag = await buildCrashDiagnostic(tmpDir, BASE_STATUS_EXITED);
    expect(diag.sessionId).toBe('xyz789');
    expect(diag.exitCode).toBe(0);
    expect(diag.exitedAt).toBe(1745669300000);
    expect(diag.status).toBe('exited');
  });

  it('reads logTail when server.log exists', async () => {
    const logContent = Array.from({ length: 30 }, (_, i) => `line ${i + 1}`).join('\n');
    await writeFile(join(tmpDir, 'server.log'), logContent);
    const diag = await buildCrashDiagnostic(tmpDir, BASE_STATUS_CRASHED);
    expect(diag.logTail).not.toBeNull();
    expect(diag.logTail).toContain('line 30');
    // Should only have last 20 lines
    expect(diag.logTail).not.toContain('line 1\n');
    expect(diag.logTail).toContain('line 11');
  });

  it('sets logTail=null when server.log is missing', async () => {
    const diag = await buildCrashDiagnostic(tmpDir, BASE_STATUS_CRASHED);
    expect(diag.logTail).toBeNull();
  });
});

describe('formatCrashDiagnostic', () => {
  const crashedDiag = {
    sessionId: 'abc123',
    status: 'crashed' as const,
    pid: 12345,
    startedAt: 1745668330000,
    lastAliveAt: 1745669242000,
    exitedAt: null,
    signal: 'SIGKILL',
    exitCode: null,
    cause: 'OOM',
    logTail: 'Error: ENOMEM: cannot allocate memory\nat process.alloc',
  };

  const exitedDiag = {
    sessionId: 'xyz789',
    status: 'exited' as const,
    pid: 99999,
    startedAt: 1745668330000,
    lastAliveAt: 1745669242000,
    exitedAt: 1745669300000,
    signal: null,
    exitCode: 0,
    cause: null,
    logTail: null,
  };

  it('includes sessionId and PID in output', () => {
    const out = formatCrashDiagnostic(crashedDiag);
    expect(out).toContain('abc123');
    expect(out).toContain('12345');
  });

  it('includes lastAlive time in output', () => {
    const out = formatCrashDiagnostic(crashedDiag);
    expect(out).toContain('Last alive');
    // Timestamp 1745669242000 → 2025-04-26
    expect(out).toContain('2025-04-26');
  });

  it('shows CRASHED for crashed status', () => {
    const out = formatCrashDiagnostic(crashedDiag);
    expect(out).toContain('CRASHED');
    expect(out).not.toContain('EXITED CLEANLY');
  });

  it('shows EXITED CLEANLY for exited status', () => {
    const out = formatCrashDiagnostic(exitedDiag);
    expect(out).toContain('EXITED CLEANLY');
    expect(out).not.toContain('CRASHED');
  });

  it('includes log tail when logTail is present', () => {
    const out = formatCrashDiagnostic(crashedDiag);
    expect(out).toContain('server.log');
    expect(out).toContain('Error: ENOMEM');
  });

  it('omits log tail section when logTail is null', () => {
    const out = formatCrashDiagnostic(exitedDiag);
    expect(out).not.toContain('server.log');
  });

  it('omits log tail section for exited status even when logTail present', () => {
    const diag = { ...exitedDiag, logTail: 'some log line' };
    const out = formatCrashDiagnostic(diag);
    expect(out).not.toContain('server.log');
    expect(out).not.toContain('some log line');
  });

  it('is pure — same input produces same output', () => {
    const out1 = formatCrashDiagnostic(crashedDiag);
    const out2 = formatCrashDiagnostic(crashedDiag);
    expect(out1).toBe(out2);
  });

  it('shows options footer', () => {
    const out = formatCrashDiagnostic(crashedDiag);
    expect(out).toContain('Options:');
    expect(out).toContain('[1] Exit and run `diptych start` for a new workflow');
    expect(out).toContain('[2]');
    expect(out).not.toContain('Start a new workflow for the same feature');
  });
});

describe('showCrashDiagnostic', () => {
  let tmpDir2: string;

  beforeEach(async () => {
    tmpDir2 = join(tmpdir(), `crash-diag-show-${Date.now()}`);
    await mkdir(tmpDir2, { recursive: true });
  });

  afterEach(async () => {
    await rm(tmpDir2, { recursive: true, force: true });
  });

  it('calls buildCrashDiagnostic and writes to stdout, then exits on key "2"', async () => {
    const written: string[] = [];
    const origWrite = process.stdout.write.bind(process.stdout);
    process.stdout.write = (data: unknown) => { written.push(String(data)); return true; };

    let exitCode: number | undefined;
    const origExit = process.exit.bind(process);
    process.exit = ((code?: number) => { exitCode = code; }) as typeof process.exit;

    try {
      await showCrashDiagnostic(tmpDir2, BASE_STATUS_CRASHED, async () => '2');
    } finally {
      process.stdout.write = origWrite;
      process.exit = origExit;
    }

    expect(written.length).toBeGreaterThan(0);
    expect(written.join('')).toContain('CRASHED');
    expect(exitCode).toBe(0);
  });

  it('exits with 0 and writes accurate new-workflow instructions when key "1" is pressed', async () => {
    const written: string[] = [];
    const origWrite = process.stdout.write.bind(process.stdout);
    process.stdout.write = (data: unknown) => { written.push(String(data)); return true; };

    let exitCode: number | undefined;
    const origExit = process.exit.bind(process);
    process.exit = ((code?: number) => { exitCode = code; }) as typeof process.exit;

    try {
      await showCrashDiagnostic(tmpDir2, BASE_STATUS_CRASHED, async () => '1');
    } finally {
      process.stdout.write = origWrite;
      process.exit = origExit;
    }

    expect(written.join('')).toContain('Exiting. Run `diptych start`');
    expect(written.join('')).not.toContain('Starting new workflow');
    expect(exitCode).toBe(0);
  });

  it('non-TTY default path exits without waiting for interactive input', async () => {
    const written: string[] = [];
    const origWrite = process.stdout.write.bind(process.stdout);
    process.stdout.write = (data: unknown) => { written.push(String(data)); return true; };

    let exitCode: number | undefined;
    const origExit = process.exit.bind(process);
    process.exit = ((code?: number) => { exitCode = code; }) as typeof process.exit;

    try {
      await showCrashDiagnostic(tmpDir2, BASE_STATUS_CRASHED, async () => '2');
    } finally {
      process.stdout.write = origWrite;
      process.exit = origExit;
    }

    expect(written.join('')).toContain('[2] Exit and inspect logs manually');
    expect(exitCode).toBe(0);
  });
});

describe('waitForCrashDiagnosticOption', () => {
  it('returns the manual-inspection option immediately when stdin is non-TTY', async () => {
    const original = process.stdin.isTTY;
    Object.defineProperty(process.stdin, 'isTTY', { configurable: true, value: false });

    try {
      await expect(waitForCrashDiagnosticOption()).resolves.toBe('2');
    } finally {
      Object.defineProperty(process.stdin, 'isTTY', { configurable: true, value: original });
    }
  });
});
