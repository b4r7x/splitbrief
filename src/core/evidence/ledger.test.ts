import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  createEvidenceLedger,
  evidenceLedgerPath,
  mutateEvidenceLedger,
  writeEvidenceLedger,
  readEvidenceLedger,
} from './ledger.js';
import { evidenceError } from './errors.js';
import { makeTask } from '#testing/helpers/factories/task.js';
import { setupEvidenceTmpDir } from '#testing/helpers/evidence-test-setup.js';

const tmpDir = setupEvidenceTmpDir();

function lockPathFor(projectDir: string, sessionId: string): string {
  return `${evidenceLedgerPath(projectDir, sessionId)}.lock`;
}

function findDeadPid(): number {
  for (let pid = 2_000_000_000; pid > 1; pid--) {
    try {
      process.kill(pid, 0);
    } catch (err: unknown) {
      const code = err && typeof err === 'object' && 'code' in err ? err.code : undefined;
      if (code === 'ESRCH') return pid;
    }
  }
  return 2_000_000_000;
}

describe('createEvidenceLedger', () => {
  it('creates a ledger with seeded tasks and zero summary', () => {
    const task = makeTask();
    const ledger = createEvidenceLedger({ sessionId: 'sess-1', feature: 'feat', tasks: [task] });
    expect(ledger.version).toBe(1);
    expect(ledger.sessionId).toBe('sess-1');
    expect(ledger.feature).toBe('feat');
    expect(ledger.tasks).toHaveLength(1);
    expect(ledger.validationSummary).toEqual({ passed: 0, failed: 0, skipped: 0, escalated: 0 });
  });
});

describe('write / read EvidenceLedger', () => {
  it('round-trips through filesystem', () => {
    const task = makeTask();
    const ledger = createEvidenceLedger({ sessionId: 'sess-1', feature: 'feat', tasks: [task] });
    writeEvidenceLedger(tmpDir.get(), 'sess-1', ledger);
    const read = readEvidenceLedger(tmpDir.get(), 'sess-1');
    expect(read).not.toBeNull();
    expect(read?.sessionId).toBe('sess-1');
  });

  it('returns null for missing file', () => {
    expect(readEvidenceLedger(tmpDir.get(), 'nonexistent')).toBeNull();
  });

  it('sequential mutations both persist', () => {
    const task = makeTask();
    const ledger = createEvidenceLedger({ sessionId: 'sess-1', feature: 'feat', tasks: [task] });
    writeEvidenceLedger(tmpDir.get(), 'sess-1', ledger);

    mutateEvidenceLedger(tmpDir.get(), 'sess-1', (current) => {
      if (current === null) throw new Error('missing ledger');
      return {
        ...current,
        tasks: current.tasks.map((entry) => ({
          ...entry,
          observedEvidence: [...entry.observedEvidence, 'workflow evidence'],
        })),
      };
    });
    mutateEvidenceLedger(tmpDir.get(), 'sess-1', (current) => {
      if (current === null) throw new Error('missing ledger');
      return {
        ...current,
        tasks: current.tasks.map((entry) => ({
          ...entry,
          observedEvidence: [...entry.observedEvidence, 'mcp evidence'],
        })),
      };
    });

    const read = readEvidenceLedger(tmpDir.get(), 'sess-1');
    expect(read?.tasks[0]?.observedEvidence).toEqual(['workflow evidence', 'mcp evidence']);
  });
});

describe('evidence ledger lock reclamation', () => {
  function seedLock(projectDir: string, sessionId: string, holder: unknown): string {
    const lockPath = lockPathFor(projectDir, sessionId);
    mkdirSync(dirname(lockPath), { recursive: true });
    writeFileSync(lockPath, JSON.stringify(holder));
    return lockPath;
  }

  it('writes the holding pid and timestamp into the lock during a mutation', () => {
    const task = makeTask();
    const ledger = createEvidenceLedger({ sessionId: 'sess-1', feature: 'feat', tasks: [task] });
    writeEvidenceLedger(tmpDir.get(), 'sess-1', ledger);

    let observedHolder: unknown = null;
    mutateEvidenceLedger(tmpDir.get(), 'sess-1', (current) => {
      observedHolder = JSON.parse(readFileSync(lockPathFor(tmpDir.get(), 'sess-1'), 'utf-8'));
      return current ?? ledger;
    });

    expect(observedHolder).toMatchObject({ pid: process.pid });
    expect(typeof (observedHolder as { acquiredAt: unknown }).acquiredAt).toBe('number');
  });

  it('reclaims a lock whose holder pid is dead', () => {
    const task = makeTask();
    const ledger = createEvidenceLedger({ sessionId: 'sess-1', feature: 'feat', tasks: [task] });
    seedLock(tmpDir.get(), 'sess-1', { pid: findDeadPid(), acquiredAt: Date.now() });

    writeEvidenceLedger(tmpDir.get(), 'sess-1', ledger);

    expect(readEvidenceLedger(tmpDir.get(), 'sess-1')?.sessionId).toBe('sess-1');
    expect(existsSync(lockPathFor(tmpDir.get(), 'sess-1'))).toBe(false);
  });

  it('reclaims a lock that has aged past the staleness threshold', () => {
    const task = makeTask();
    const ledger = createEvidenceLedger({ sessionId: 'sess-1', feature: 'feat', tasks: [task] });
    seedLock(tmpDir.get(), 'sess-1', { pid: process.pid, acquiredAt: Date.now() - 60_000 });

    writeEvidenceLedger(tmpDir.get(), 'sess-1', ledger);

    expect(readEvidenceLedger(tmpDir.get(), 'sess-1')?.sessionId).toBe('sess-1');
    expect(existsSync(lockPathFor(tmpDir.get(), 'sess-1'))).toBe(false);
  });

  it('reclaims a lock with corrupt holder content', () => {
    const task = makeTask();
    const ledger = createEvidenceLedger({ sessionId: 'sess-1', feature: 'feat', tasks: [task] });
    const lockPath = lockPathFor(tmpDir.get(), 'sess-1');
    mkdirSync(dirname(lockPath), { recursive: true });
    writeFileSync(lockPath, '{ broken');

    writeEvidenceLedger(tmpDir.get(), 'sess-1', ledger);

    expect(readEvidenceLedger(tmpDir.get(), 'sess-1')?.sessionId).toBe('sess-1');
  });

  it('times out with a structured error when a live, fresh lock is held', () => {
    const task = makeTask();
    const ledger = createEvidenceLedger({ sessionId: 'sess-1', feature: 'feat', tasks: [task] });
    writeEvidenceLedger(tmpDir.get(), 'sess-1', ledger);
    seedLock(tmpDir.get(), 'sess-1', { pid: process.pid, acquiredAt: Date.now() });

    let caught: unknown;
    try {
      mutateEvidenceLedger(tmpDir.get(), 'sess-1', (current) => current ?? ledger);
    } catch (err) {
      caught = err;
    }

    expect(evidenceError.isLockTimeout(caught)).toBe(true);
    expect(existsSync(lockPathFor(tmpDir.get(), 'sess-1'))).toBe(true);
  });
});
