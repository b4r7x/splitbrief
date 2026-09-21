import type { RunRecord } from '../../../src/core/sessions/run-record.js';

const DEFAULTS: RunRecord = {
  ref: { projectDir: '/tmp/run-record-factory', sessionId: '2026-09-14-feature' },
  feature: 'feature',
  mode: 'standard',
  startedAt: '2026-09-14T00:00:00.000Z',
  hydration: { kind: 'missing' },
  status: { kind: 'closed', as: 'complete' },
  summary: null,
  ledger: null,
  checkpoint: null,
};

/** One run's record, with only the facts a test is about stated. */
export function makeRunRecord(overrides: Partial<RunRecord> = {}): RunRecord {
  return { ...DEFAULTS, ...overrides };
}
