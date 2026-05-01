import { describe, expect, it } from 'vitest';
import { EvidenceLedgerSchema, EvidenceTaskSchema } from './evidence.js';

function minimalTask(id: string) {
  return {
    id,
    title: 'Test task',
    file: 'src/foo.ts',
    status: 'pending',
    retries: 0,
    changedFiles: [],
    validation: [],
    expectedEvidence: [],
    observedEvidence: [],
    escalated: false,
  };
}

function minimalLedger() {
  return {
    version: 1 as const,
    sessionId: 's1',
    feature: 'f',
    generatedAt: new Date().toISOString(),
    tasks: [],
    validationSummary: { passed: 0, failed: 0, skipped: 0, escalated: 0 },
  };
}

describe('EvidenceLedgerSchema — briefHash backward-compatibility', () => {
  it('parses a legacy ledger without briefHash', () => {
    const result = EvidenceLedgerSchema.safeParse(minimalLedger());
    expect(result.success).toBe(true);
  });

  it('parses a ledger with briefHash: null', () => {
    const result = EvidenceLedgerSchema.safeParse({ ...minimalLedger(), briefHash: null });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.briefHash).toBeNull();
  });

  it('parses a ledger with briefHash as a string', () => {
    const result = EvidenceLedgerSchema.safeParse({ ...minimalLedger(), briefHash: 'abc123' });
    expect(result.success).toBe(true);
  });
});

describe('EvidenceTaskSchema — briefHash backward-compatibility', () => {
  it('parses a task entry without briefHash', () => {
    const result = EvidenceTaskSchema.safeParse(minimalTask('T001'));
    expect(result.success).toBe(true);
  });

  it('parses a task entry with briefHash: null', () => {
    const result = EvidenceTaskSchema.safeParse({ ...minimalTask('T001'), briefHash: null });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.briefHash).toBeNull();
  });

  it('parses a task entry with briefHash as a string', () => {
    const result = EvidenceTaskSchema.safeParse({ ...minimalTask('T001'), briefHash: 'abc123' });
    expect(result.success).toBe(true);
  });
});
