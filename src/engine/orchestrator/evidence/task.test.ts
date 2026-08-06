import { describe, expect, it } from 'vitest';
import { createEvidenceLedger } from '../../../core/evidence/ledger-state.js';
import { EvidenceLedgerSchema } from '../../../core/schemas/evidence.js';
import {
  recordLocalTaskEvidence,
  recordRetryOrEscalationEvidence,
  recordSkippedTaskEvidence,
} from './task.js';
import { makeTask } from '#testing/helpers/factories/task.js';
import type { ValidationResult } from '../validation/result.js';

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
      ledger,
      task,
      status: 'done',
      validation: [passing('typecheck'), passing('lint')],
    });
    expect(updated.tasks[0]?.status).toBe('done');
    expect(updated.tasks[0]?.observedEvidence).toContain('typecheck passed');
    expect(updated.tasks[0]?.observedEvidence).toContain('lint passed');
    expect(updated.tasks[0]?.observedEvidence).toContain('task reached done');
  });

  it('flags a failing stage as baseline-exempt when its stage is exempt, and only then', () => {
    const task = makeTask();
    const ledger = createEvidenceLedger({ sessionId: 'sess-1', feature: 'feat', tasks: [task] });
    const updated = recordLocalTaskEvidence({
      ledger,
      task,
      status: 'done',
      validation: [failing('typecheck', 'error'), failing('lint', 'error')],
      exemptStages: ['typecheck'],
    });
    expect(updated.tasks[0]?.validation[0]).toMatchObject({ passed: false, baselineExempt: true });
    expect(updated.tasks[0]?.validation[1]).toEqual({
      stage: 'lint',
      passed: false,
      errorSummary: 'error',
    });
  });

  it('never rewrites passed when marking a stage baseline-exempt', () => {
    const task = makeTask();
    const ledger = createEvidenceLedger({ sessionId: 'sess-1', feature: 'feat', tasks: [task] });
    const updated = recordLocalTaskEvidence({
      ledger,
      task,
      status: 'done',
      validation: [failing('typecheck', 'error')],
      exemptStages: ['typecheck'],
    });
    expect(updated.tasks[0]?.validation[0]?.passed).toBe(false);
    expect(updated.tasks[0]?.validation[0]?.baselineExempt).toBe(true);
  });

  it('records a pre-existing-failure line for an exempt stage alongside passing lines', () => {
    const task = makeTask();
    const ledger = createEvidenceLedger({ sessionId: 'sess-1', feature: 'feat', tasks: [task] });
    const updated = recordLocalTaskEvidence({
      ledger,
      task,
      status: 'done',
      validation: [failing('typecheck', 'error'), passing('lint')],
      exemptStages: ['typecheck'],
    });
    expect(updated.tasks[0]?.observedEvidence).toContain('typecheck failed (pre-existing)');
    expect(updated.tasks[0]?.observedEvidence).toContain('lint passed');
    expect(updated.tasks[0]?.observedEvidence).not.toContain('typecheck passed');
  });

  it('round-trips a ledger without the exempt flag through the schema unchanged', () => {
    const task = makeTask();
    const ledger = createEvidenceLedger({ sessionId: 'sess-1', feature: 'feat', tasks: [task] });
    const updated = recordLocalTaskEvidence({
      ledger,
      task,
      status: 'done',
      validation: [failing('typecheck', 'error'), passing('lint')],
    });
    expect(EvidenceLedgerSchema.parse(updated)).toEqual(updated);
    expect(updated.tasks[0]?.validation[0]).toEqual({
      stage: 'typecheck',
      passed: false,
      errorSummary: 'error',
    });
  });
});

describe('recordRetryOrEscalationEvidence', () => {
  it('records escalation', () => {
    const task = makeTask();
    const ledger = createEvidenceLedger({ sessionId: 'sess-1', feature: 'feat', tasks: [task] });
    const updated = recordRetryOrEscalationEvidence({
      ledger,
      task,
      status: 'escalated',
      escalated: true,
      validation: [failing('typecheck', 'error')],
    });
    expect(updated.tasks[0]?.escalated).toBe(true);
    expect(updated.tasks[0]?.observedEvidence).toContain('task reached escalated');
  });

  it('flags and reports an exempt stage on the escalation path too', () => {
    const task = makeTask();
    const ledger = createEvidenceLedger({ sessionId: 'sess-1', feature: 'feat', tasks: [task] });
    const updated = recordRetryOrEscalationEvidence({
      ledger,
      task,
      status: 'escalated',
      escalated: true,
      validation: [failing('lint', 'error')],
      exemptStages: ['lint'],
    });
    expect(updated.tasks[0]?.validation[0]).toMatchObject({ passed: false, baselineExempt: true });
    expect(updated.tasks[0]?.observedEvidence).toContain('lint failed (pre-existing)');
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
