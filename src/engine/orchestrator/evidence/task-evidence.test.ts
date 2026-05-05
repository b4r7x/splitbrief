import { describe, expect, it } from 'vitest';
import { createEvidenceLedger } from './ledger.js';
import {
  recordLocalTaskEvidence,
  recordRetryOrEscalationEvidence,
  recordSkippedTaskEvidence,
} from './task-evidence.js';
import { makeTask } from '../../../../testing/helpers/factories/task.js';
import type { ValidationResult } from '../validation.js';

function passing(stage: 'typecheck' | 'lint' | 'test'): ValidationResult {
  return { passed: true, stage };
}
function failing(stage: 'typecheck' | 'lint' | 'test', error: string): ValidationResult {
  return { passed: false, stage, error };
}

describe('recordLocalTaskEvidence', () => {
  it('records validation pass and observedEvidence', () => {
    const task = makeTask();
    const ledger = createEvidenceLedger({ sessionId: 'sess-1', feature: 'feat', tasks: [task] });
    const updated = recordLocalTaskEvidence({
      ledger, task, status: 'done', validation: [passing('typecheck'), passing('lint')],
    });
    expect(updated.tasks[0]?.status).toBe('done');
    expect(updated.tasks[0]?.observedEvidence).toContain('typecheck passed');
    expect(updated.tasks[0]?.observedEvidence).toContain('lint passed');
    expect(updated.tasks[0]?.observedEvidence).toContain('task reached done');
  });
});

describe('recordRetryOrEscalationEvidence', () => {
  it('records escalation', () => {
    const task = makeTask();
    const ledger = createEvidenceLedger({ sessionId: 'sess-1', feature: 'feat', tasks: [task] });
    const updated = recordRetryOrEscalationEvidence({
      ledger, task, status: 'escalated', escalated: true, validation: [failing('typecheck', 'error')],
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
