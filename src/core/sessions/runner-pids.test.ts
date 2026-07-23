import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTempDir, cleanupTempDir } from '#testing/helpers/temp-dir.js';
import { sessionDir } from '../paths.js';
import {
  recordRunnerPid,
  releaseRunnerPid,
  releaseRunnerPids,
  readRunnerPids,
} from './runner-pids.js';

let tmp: string;
const itUnix = process.platform === 'win32' ? it.skip : it;

afterEach(() => {
  if (tmp) cleanupTempDir(tmp);
});

describe('runner pid ledger', () => {
  it('recordRunnerPid, readRunnerPids, releaseRunnerPid, and releaseRunnerPids round-trip', () => {
    tmp = createTempDir('runner-pids-test');
    const ref = { projectDir: tmp, sessionId: '2024-01-01-test' };

    expect(readRunnerPids(ref)).toEqual([]);

    recordRunnerPid(ref, 111, 1000);
    recordRunnerPid(ref, 222, 2000);
    expect(readRunnerPids(ref)).toEqual([
      { pid: 111, startTimeMs: 1000 },
      { pid: 222, startTimeMs: 2000 },
    ]);

    releaseRunnerPid(ref, 111);
    expect(readRunnerPids(ref)).toEqual([{ pid: 222, startTimeMs: 2000 }]);

    releaseRunnerPids(ref, [{ pid: 222, startTimeMs: 2000 }]);
    expect(readRunnerPids(ref)).toEqual([]);
  });

  it('releaseRunnerPids spares a pid recorded after the snapshot was taken', () => {
    tmp = createTempDir('runner-pids-test');
    const ref = { projectDir: tmp, sessionId: '2024-01-01-concurrent' };

    recordRunnerPid(ref, 111, 1000);
    const snapshot = readRunnerPids(ref);

    // A concurrently resumed session records a fresh pid after the snapshot.
    recordRunnerPid(ref, 333, 3000);

    releaseRunnerPids(ref, snapshot);

    expect(readRunnerPids(ref)).toEqual([{ pid: 333, startTimeMs: 3000 }]);
  });

  it('releaseRunnerPids does not release a pid whose recorded start time changed since the snapshot', () => {
    tmp = createTempDir('runner-pids-test');
    const ref = { projectDir: tmp, sessionId: '2024-01-01-recycled' };

    recordRunnerPid(ref, 111, 1000);
    const snapshot = readRunnerPids(ref);

    // The pid was recycled and re-recorded with a new start time before the reap completed.
    recordRunnerPid(ref, 111, 9000);

    releaseRunnerPids(ref, snapshot);

    expect(readRunnerPids(ref)).toEqual([{ pid: 111, startTimeMs: 9000 }]);
  });

  it('skips corrupt-JSON and wrong-shape lines but keeps the valid entries, warning on stderr', () => {
    tmp = createTempDir('runner-pids-test');
    const ref = { projectDir: tmp, sessionId: '2024-01-01-corrupt' };
    recordRunnerPid(ref, 111, 1000);
    const ledgerPath = join(sessionDir(tmp, ref.sessionId), 'runner-pids.jsonl');
    writeFileSync(
      ledgerPath,
      [
        '{"pid":111,"startTimeMs":1000}',
        '{not valid json',
        '{"pid":"nope","startTimeMs":1000}',
        '{"pid":222,"startTimeMs":2000}',
        '',
      ].join('\n'),
    );

    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      expect(readRunnerPids(ref)).toEqual([
        { pid: 111, startTimeMs: 1000 },
        { pid: 222, startTimeMs: 2000 },
      ]);
      const warnings = stderr.mock.calls.flat().join('');
      expect(warnings).toContain('failed to parse runner pid entry');
      expect(warnings).toContain('invalid runner pid entry');
    } finally {
      stderr.mockRestore();
    }
  });

  itUnix('refuses to read through a symlinked runner pid ledger', () => {
    tmp = createTempDir('runner-pids-test');
    const ref = { projectDir: tmp, sessionId: '2024-01-01-symlink' };
    recordRunnerPid(ref, 111, 1000);
    const ledgerPath = join(sessionDir(tmp, ref.sessionId), 'runner-pids.jsonl');

    const outside = mkdtempSync(join(tmpdir(), 'diptych-runner-pids-outside-'));
    try {
      const outsideLedger = join(outside, 'runner-pids.jsonl');
      writeFileSync(outsideLedger, '{"pid":999,"startTimeMs":5000}\n');
      rmSync(ledgerPath, { force: true });
      symlinkSync(outsideLedger, ledgerPath);

      expect(readRunnerPids(ref)).toEqual([]);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });
});
