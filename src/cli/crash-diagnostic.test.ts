import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdir, rm } from 'node:fs/promises';
import type { ServerStatus } from '../engine/ipc/lockfile.js';
import {
  formatCrashDiagnostic,
  showCrashDiagnostic,
  waitForCrashDiagnosticOption,
} from './crash-diagnostic.js';

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

  it('shows options footer', () => {
    const out = formatCrashDiagnostic(crashedDiag);
    expect(out).toContain('Options:');
    expect(out).toMatch(/\[1\]/);
    expect(out).toMatch(/diptych start/);
    expect(out).toMatch(/\[2\]/);
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

  async function withProcessStubs<T>(
    fn: (ctx: { written: string[]; exitCode: () => number | undefined }) => Promise<T>,
    opts?: { stubTTY?: boolean },
  ): Promise<T> {
    const written: string[] = [];
    const origWrite = process.stdout.write.bind(process.stdout);
    process.stdout.write = (data: unknown) => {
      written.push(String(data));
      return true;
    };

    let exitCode: number | undefined;
    const origExit = process.exit.bind(process);
    process.exit = ((code?: number) => {
      exitCode = code;
    }) as typeof process.exit;

    const origTTY = opts?.stubTTY ? process.stdin.isTTY : undefined;
    if (opts?.stubTTY)
      Object.defineProperty(process.stdin, 'isTTY', { configurable: true, value: false });

    try {
      return await fn({ written, exitCode: () => exitCode });
    } finally {
      process.stdout.write = origWrite;
      process.exit = origExit;
      if (opts?.stubTTY)
        Object.defineProperty(process.stdin, 'isTTY', { configurable: true, value: origTTY });
    }
  }

  it('calls buildCrashDiagnostic and writes to stdout, then exits on key "2"', async () => {
    await withProcessStubs(async ({ written, exitCode }) => {
      await showCrashDiagnostic(tmpDir2, BASE_STATUS_CRASHED, async () => '2');
      expect(written.length).toBeGreaterThan(0);
      expect(written.join('')).toContain('CRASHED');
      expect(exitCode()).toBe(0);
    });
  });

  it('exits with 0 and writes accurate new-workflow instructions when key "1" is pressed', async () => {
    await withProcessStubs(async ({ written, exitCode }) => {
      await showCrashDiagnostic(tmpDir2, BASE_STATUS_CRASHED, async () => '1');
      expect(written.join('')).toContain('Exiting. Run `diptych start`');
      expect(written.join('')).not.toContain('Starting new workflow');
      expect(exitCode()).toBe(0);
    });
  });

  it('non-TTY default path exits without waiting for interactive input', async () => {
    await withProcessStubs(
      async ({ written, exitCode }) => {
        await showCrashDiagnostic(tmpDir2, BASE_STATUS_CRASHED, async () => '2');
        expect(written.join('')).toContain('[2] Exit and inspect logs manually');
        expect(exitCode()).toBe(0);
      },
      { stubTTY: true },
    );
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
