import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildEvidenceSummary,
  buildRejectionContext,
  createEvidenceLedger,
  readEvidenceLedger,
  recordApprovalEvidence,
  recordFinalReviewEvidence,
  recordLocalTaskEvidence,
  recordRejectionEvidence,
  recordRetryOrEscalationEvidence,
  recordSkippedTaskEvidence,
  writeEvidenceLedger,
} from './evidence.js';
import { makeTask } from '../../../../testing/helpers/factories/task.js';
import type { ValidationResult } from '../validation.js';

function passing(stage: 'tsc' | 'lint' | 'test'): ValidationResult {
  return { passed: true, stage };
}
function failing(stage: 'tsc' | 'lint' | 'test', error: string): ValidationResult {
  return { passed: false, stage, error };
}

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'evidence-test-'));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

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

describe('recordLocalTaskEvidence', () => {
  it('records validation pass and observedEvidence', () => {
    const task = makeTask();
    const ledger = createEvidenceLedger({ sessionId: 'sess-1', feature: 'feat', tasks: [task] });
    const updated = recordLocalTaskEvidence({
      ledger, task, status: 'done', validation: [passing('tsc'), passing('lint')],
    });
    expect(updated.tasks[0]?.status).toBe('done');
    expect(updated.tasks[0]?.observedEvidence).toContain('tsc passed');
    expect(updated.tasks[0]?.observedEvidence).toContain('lint passed');
    expect(updated.tasks[0]?.observedEvidence).toContain('task reached done');
  });
});

describe('recordRetryOrEscalationEvidence', () => {
  it('records escalation', () => {
    const task = makeTask();
    const ledger = createEvidenceLedger({ sessionId: 'sess-1', feature: 'feat', tasks: [task] });
    const updated = recordRetryOrEscalationEvidence({
      ledger, task, status: 'escalated', escalated: true, validation: [failing('tsc', 'error')],
    });
    expect(updated.tasks[0]?.escalated).toBe(true);
    expect(updated.tasks[0]?.observedEvidence).toContain('task reached escalated');
  });
});

describe('recordSkippedTaskEvidence', () => {
  it('marks task as skipped with reason', () => {
    const task = makeTask();
    const ledger = createEvidenceLedger({ sessionId: 'sess-1', feature: 'feat', tasks: [task] });
    const updated = recordSkippedTaskEvidence({ ledger, task, reason: 'dep failed' });
    expect(updated.tasks[0]?.status).toBe('skipped');
    expect(updated.tasks[0]?.observedEvidence).toContain('skipped: dep failed');
  });
});

describe('recordFinalReviewEvidence', () => {
  it('marks final review as written', () => {
    const task = makeTask();
    const ledger = createEvidenceLedger({ sessionId: 'sess-1', feature: 'feat', tasks: [task] });
    const local = recordLocalTaskEvidence({ ledger, task, status: 'done', validation: [passing('tsc')] });
    const updated = recordFinalReviewEvidence({ ledger: local, status: 'written' });
    expect(updated.finalReview?.status).toBe('written');
    expect(updated.tasks[0]?.observedEvidence).toContain('final review written');
  });
});

describe('recordApprovalEvidence / recordRejectionEvidence', () => {
  it('appends approval entry', () => {
    const task = makeTask();
    const ledger = createEvidenceLedger({ sessionId: 'sess-1', feature: 'feat', tasks: [task] });
    const updated = recordApprovalEvidence({
      ledger, tier: 'confirm', actionClass: 'destructive',
      actionDescription: 'rm -rf', reason: 'needed',
    });
    expect(updated.approvals).toHaveLength(1);
  });

  it('appends rejection entry', () => {
    const task = makeTask();
    const ledger = createEvidenceLedger({ sessionId: 'sess-1', feature: 'feat', tasks: [task] });
    const updated = recordRejectionEvidence({
      ledger, tier: 'sticky', actionClass: 'write_out_of_scope',
      actionDescription: 'write foo', reason: 'denied',
    });
    expect(updated.rejections).toHaveLength(1);
  });
});

describe('buildRejectionContext', () => {
  it('returns empty string for no rejections', () => {
    const task = makeTask();
    const ledger = createEvidenceLedger({ sessionId: 'sess-1', feature: 'feat', tasks: [task] });
    expect(buildRejectionContext(ledger)).toBe('');
  });
});

describe('buildEvidenceSummary', () => {
  it('produces summary counts', () => {
    const task = makeTask();
    const ledger = createEvidenceLedger({ sessionId: 'sess-1', feature: 'feat', tasks: [task] });
    const local = recordLocalTaskEvidence({ ledger, task, status: 'done', validation: [passing('tsc')] });
    const summary = buildEvidenceSummary(local);
    expect(summary.totalTasks).toBe(1);
    expect(summary.tasksWithValidationEvidence).toBe(1);
  });
});

describe('write / read EvidenceLedger', () => {
  it('round-trips through filesystem', () => {
    const task = makeTask();
    const ledger = createEvidenceLedger({ sessionId: 'sess-1', feature: 'feat', tasks: [task] });
    writeEvidenceLedger(tmpDir, 'sess-1', ledger);
    const read = readEvidenceLedger(tmpDir, 'sess-1');
    expect(read).not.toBeNull();
    expect(read?.sessionId).toBe('sess-1');
  });

  it('returns null for missing file', () => {
    expect(readEvidenceLedger(tmpDir, 'nonexistent')).toBeNull();
  });
});
