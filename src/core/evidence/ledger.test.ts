import { describe, expect, it } from 'vitest';
import {
  createEvidenceLedger,
  mutateEvidenceLedger,
  writeEvidenceLedger,
  readEvidenceLedger,
} from './ledger.js';
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

  it('merges concurrent mutations under the ledger lock', () => {
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
