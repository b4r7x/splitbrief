import { describe, expect, it } from 'vitest';
import { createEvidenceLedger } from './ledger-state.js';
import { mutateEvidenceLedger, writeEvidenceLedger, readEvidenceLedger } from './ledger-storage.js';
import { persistRecoveryBudgetResource, readRecoveryBudgetResources } from './recovery-journal.js';
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

describe('write / read EvidenceLedger', () => {
  it('returns null for missing file', () => {
    expect(readEvidenceLedger({ projectDir: tmpDir.get(), sessionId: 'nonexistent' })).toBeNull();
  });

  it('round-trips and preserves sequential mutations', () => {
    const task = makeTask();
    const ledger = createEvidenceLedger({ sessionId: 'sess-1', feature: 'feat', tasks: [task] });
    writeEvidenceLedger({ projectDir: tmpDir.get(), sessionId: 'sess-1' }, ledger);

    mutateEvidenceLedger({ projectDir: tmpDir.get(), sessionId: 'sess-1' }, (current) => {
      if (current === null) throw new Error('missing ledger');
      return {
        ...current,
        tasks: current.tasks.map((entry) => ({
          ...entry,
          observedEvidence: [...entry.observedEvidence, 'workflow evidence'],
        })),
      };
    });
    mutateEvidenceLedger({ projectDir: tmpDir.get(), sessionId: 'sess-1' }, (current) => {
      if (current === null) throw new Error('missing ledger');
      return {
        ...current,
        tasks: current.tasks.map((entry) => ({
          ...entry,
          observedEvidence: [...entry.observedEvidence, 'mcp evidence'],
        })),
      };
    });

    const read = readEvidenceLedger({ projectDir: tmpDir.get(), sessionId: 'sess-1' });
    expect(read?.sessionId).toBe('sess-1');
    expect(read?.tasks[0]?.observedEvidence).toEqual(['workflow evidence', 'mcp evidence']);
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
          observedEvidence: [...entry.observedEvidence, 'outer'],
        })),
      };
    });

    mutateEvidenceLedger(ref, (current) => {
      if (current === null) throw new Error('missing ledger');
      return {
        ...current,
        tasks: current.tasks.map((entry) => ({
          ...entry,
          observedEvidence: [...entry.observedEvidence, 'after'],
        })),
      };
    });

    const read = readEvidenceLedger(ref);
    expect(read?.tasks[0]?.observedEvidence).toEqual(['outer', 'after']);
  });
});

describe('provider-dependent budget resources in the evidence store', () => {
  it('persists beside the ledger without disturbing it', () => {
    const ref = { projectDir: tmpDir.get(), sessionId: 'sess-1' };
    const ledger = createEvidenceLedger({
      sessionId: 'sess-1',
      feature: 'feat',
      tasks: [makeTask()],
    });
    writeEvidenceLedger(ref, ledger);

    persistRecoveryBudgetResource(ref, {
      epochId: 'epoch-1',
      operationId: 'operation-1',
      kind: 'reservation',
      resource: {
        kind: 'provider-dependent',
        accountingKey: 'session-1/epoch-1/operation-1',
        pricingIdentity: 'opencode/auto',
        envelope: {
          version: 1,
          dispatchLimit: 64,
          callCount: 1,
          totalPromptBytes: 1_000,
          totalInputTokensUpperBound: 8_000,
          totalOutputTokensUpperBound: 8_192,
          totalNormalizedOutputBytes: 96 * 1_024,
          totalDeclaredArtifactBytes: 96 * 1_024,
          callsDigest: 'calls'.padEnd(64, '0'),
        },
        observedUsage: null,
        resolvedPricing: null,
      },
    });

    expect(readEvidenceLedger(ref)).toEqual(ledger);
    expect(readRecoveryBudgetResources(ref, 'epoch-1', 'operation-1')).toHaveLength(1);
  });
});
