import { describe, expect, it } from 'vitest';
import { hashTaskBrief } from './brief-hash.js';
import {
  createEvidenceLedger,
  emptyEvidenceTask,
  findOrSeed,
  upsertEvidenceTask,
} from './ledger-state.js';
import { mutateEvidenceLedger, writeEvidenceLedger, readEvidenceLedger } from './ledger-storage.js';
import { evidenceError } from './errors.js';
import { makeTask } from '#testing/helpers/factories/task.js';
import { setupEvidenceTmpDir } from '#testing/helpers/evidence-test-setup.js';

const tmpDir = setupEvidenceTmpDir();

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

describe('upsertEvidenceTask', () => {
  it('replaces a known task and appends an unknown one, recomputing the summary', () => {
    const t1 = makeTask({ id: 'T001' });
    const t2 = makeTask({ id: 'T002' });
    const ledger = createEvidenceLedger({ sessionId: 'sess-1', feature: 'feat', tasks: [t1, t2] });

    const updated = upsertEvidenceTask(ledger, {
      ...emptyEvidenceTask(t1),
      checks: [{ id: 'typecheck', ts: '2026-01-01T00:00:00.000Z' }],
    });
    expect(updated.tasks).toHaveLength(2);
    expect(updated.tasks[0]?.checks).toEqual([{ id: 'typecheck', ts: '2026-01-01T00:00:00.000Z' }]);
    expect(updated.validationSummary).toEqual({ passed: 0, failed: 0, skipped: 0, escalated: 0 });

    const appended = upsertEvidenceTask(updated, {
      ...emptyEvidenceTask(makeTask({ id: 'T003' })),
      status: 'done',
    });
    expect(appended.tasks.map((entry) => entry.id)).toEqual(['T001', 'T002', 'T003']);
    expect(appended.validationSummary).toEqual({ passed: 1, failed: 0, skipped: 0, escalated: 0 });
  });
});

describe('findOrSeed', () => {
  it('re-stamps a recorded entry with the hash of the revised brief', () => {
    const planned = makeTask({ id: 'T001', revision: 1 });
    const revised = makeTask({ id: 'T001', revision: 2, description: 'Rewritten by the planner' });
    const ledger = createEvidenceLedger({ sessionId: 'sess-1', feature: 'feat', tasks: [planned] });
    const recorded = upsertEvidenceTask(ledger, {
      ...findOrSeed(ledger, planned),
      status: 'failed',
    });
    expect(recorded.tasks[0]?.briefHash).toBe(hashTaskBrief([planned]));

    const entry = findOrSeed(recorded, revised);

    expect(entry.status).toBe('failed');
    expect(entry.briefHash).toBe(hashTaskBrief([revised]));
    expect(entry.briefHash).not.toBe(hashTaskBrief([planned]));
  });
});

describe('write / read EvidenceLedger', () => {
  it('returns null for missing file', () => {
    expect(readEvidenceLedger({ projectDir: tmpDir.get(), sessionId: 'nonexistent' })).toBeNull();
  });

  it('round-trips and preserves sequential mutations to the checks log', () => {
    const task = makeTask();
    const ledger = createEvidenceLedger({ sessionId: 'sess-1', feature: 'feat', tasks: [task] });
    writeEvidenceLedger({ projectDir: tmpDir.get(), sessionId: 'sess-1' }, ledger);

    mutateEvidenceLedger({ projectDir: tmpDir.get(), sessionId: 'sess-1' }, (current) => {
      if (current === null) throw new Error('missing ledger');
      return {
        ...current,
        tasks: current.tasks.map((entry) => ({
          ...entry,
          checks: [...(entry.checks ?? []), { id: 'workflow', ts: '2026-01-01T00:00:00.000Z' }],
        })),
      };
    });
    mutateEvidenceLedger({ projectDir: tmpDir.get(), sessionId: 'sess-1' }, (current) => {
      if (current === null) throw new Error('missing ledger');
      return {
        ...current,
        tasks: current.tasks.map((entry) => ({
          ...entry,
          checks: [...(entry.checks ?? []), { id: 'mcp', ts: '2026-01-01T00:00:01.000Z' }],
        })),
      };
    });

    const read = readEvidenceLedger({ projectDir: tmpDir.get(), sessionId: 'sess-1' });
    expect(read?.sessionId).toBe('sess-1');
    expect(read?.tasks[0]?.checks?.map((entry) => entry.id)).toEqual(['workflow', 'mcp']);
  });

  it('loads an old evidence.json that still carries the retired fields', () => {
    const ref = { projectDir: tmpDir.get(), sessionId: 'sess-legacy' };
    const task = makeTask();
    const ledger = createEvidenceLedger({
      sessionId: 'sess-legacy',
      feature: 'feat',
      tasks: [task],
    });
    const legacy = {
      ...ledger,
      tasks: ledger.tasks.map((entry) => ({
        ...entry,
        expectedEvidence: ['the greeting returns'],
        observedEvidence: ['task reached done'],
      })),
    };
    writeEvidenceLedger(ref, legacy);

    const read = readEvidenceLedger(ref);

    expect(read?.tasks[0]?.id).toBe(task.id);
    expect(read?.tasks[0]?.observedEvidence).toEqual(['task reached done']);
  });
});

describe('evidence ledger lock', () => {
  it('maps nested same-session mutation to lock timeout, releases lock, then allows a later mutation', () => {
    const ref = { projectDir: tmpDir.get(), sessionId: 'sess-1' };
    const task = makeTask();
    const ledger = createEvidenceLedger({ sessionId: 'sess-1', feature: 'feat', tasks: [task] });
    writeEvidenceLedger(ref, ledger);

    let innerEntered = false;
    mutateEvidenceLedger(ref, (current) => {
      if (current === null) throw new Error('missing ledger');
      let caught: unknown;
      try {
        mutateEvidenceLedger(ref, () => {
          innerEntered = true;
          return current;
        });
      } catch (err) {
        caught = err;
      }
      expect(innerEntered).toBe(false);
      expect(evidenceError.isLockTimeout(caught)).toBe(true);

      return {
        ...current,
        tasks: current.tasks.map((entry) => ({
          ...entry,
          checks: [...(entry.checks ?? []), { id: 'outer', ts: '2026-01-01T00:00:00.000Z' }],
        })),
      };
    });

    mutateEvidenceLedger(ref, (current) => {
      if (current === null) throw new Error('missing ledger');
      return {
        ...current,
        tasks: current.tasks.map((entry) => ({
          ...entry,
          checks: [...(entry.checks ?? []), { id: 'after', ts: '2026-01-01T00:00:01.000Z' }],
        })),
      };
    });

    const read = readEvidenceLedger(ref);
    expect(read?.tasks[0]?.checks?.map((entry) => entry.id)).toEqual(['outer', 'after']);
  });
});
