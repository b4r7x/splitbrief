import { describe, expect, it } from 'vitest';
import { createEvidenceLedger } from '../../../core/evidence/ledger-state.js';
import { EvidenceLedgerSchema } from '../../../core/schemas/evidence.js';
import {
  recordLocalTaskEvidence,
  recordRetryOrEscalationEvidence,
  recordSkippedTaskEvidence,
} from './task.js';
import { makeTask } from '#testing/helpers/factories/task.js';
import { skippedStage } from '../validation/stage.js';
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

  it('keeps the validation command and recorded output so the review can quote them', () => {
    const task = makeTask();
    const ledger = createEvidenceLedger({ sessionId: 'sess-1', feature: 'feat', tasks: [task] });
    const updated = recordLocalTaskEvidence({
      ledger,
      task,
      status: 'done',
      validation: [
        {
          passed: true,
          stage: 'test',
          command: 'npm test',
          output: 'Tests  4 passed (4)',
        },
        { passed: true, stage: 'typecheck', command: 'npm run typecheck', output: '   \n' },
      ],
    });

    const [test, typecheck] = updated.tasks[0]?.validation ?? [];
    expect(test).toMatchObject({
      stage: 'test',
      command: 'npm test',
      output: 'Tests  4 passed (4)',
    });
    expect(typecheck?.command).toBe('npm run typecheck');
    expect(typecheck?.output).toBeUndefined();
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

  it('skipped stage records skipped, not passed', () => {
    const task = makeTask();
    const ledger = createEvidenceLedger({ sessionId: 'sess-1', feature: 'feat', tasks: [task] });
    const updated = recordLocalTaskEvidence({
      ledger,
      task,
      status: 'done',
      validation: [skippedStage('test', 'no affected test file found')],
    });

    expect(updated.tasks[0]?.validation[0]).toMatchObject({
      stage: 'test',
      skipped: true,
      skippedReason: 'no affected test file found',
    });
    expect(updated.tasks[0]?.observedEvidence).toContain(
      'test skipped (no affected test file found)',
    );
    expect(updated.tasks[0]?.observedEvidence).not.toContain('test passed');
  });

  it('diff written for 2 files', () => {
    const task = makeTask({ file: 'src/a.ts', files: ['src/a.ts', 'src/a.test.ts'] });
    const ledger = createEvidenceLedger({ sessionId: 'sess-1', feature: 'feat', tasks: [task] });
    const updated = recordLocalTaskEvidence({ ledger, task, status: 'done', validation: [] });

    expect(updated.tasks[0]?.changedFiles).toEqual(['src/a.ts', 'src/a.test.ts']);
    expect(updated.tasks[0]?.observedEvidence).toContain('diff written for 2 files');
  });

  it('keeps naming the single declared file when only one file changed', () => {
    const task = makeTask();
    const ledger = createEvidenceLedger({ sessionId: 'sess-1', feature: 'feat', tasks: [task] });
    const updated = recordLocalTaskEvidence({ ledger, task, status: 'done', validation: [] });

    expect(updated.tasks[0]?.observedEvidence).toContain(`diff written for ${task.file}`);
  });

  it('exhausted task records failed status and keeps every validation attempt', () => {
    const task = makeTask();
    const ledger = createEvidenceLedger({ sessionId: 'sess-1', feature: 'feat', tasks: [task] });
    const afterFirst = recordLocalTaskEvidence({
      ledger,
      task,
      status: 'in_progress',
      validation: [failing('test', 'attempt one')],
    });
    const afterRetry = recordRetryOrEscalationEvidence({
      ledger: afterFirst,
      task,
      status: 'failed',
      escalated: false,
      validation: [failing('test', 'attempt two')],
    });
    const exhausted = recordRetryOrEscalationEvidence({
      ledger: afterRetry,
      task,
      status: 'failed',
      escalated: false,
      validation: [failing('test', 'attempt three')],
    });

    expect(exhausted.tasks[0]?.status).toBe('failed');
    expect(exhausted.tasks[0]?.validation).toHaveLength(3);
    expect(exhausted.tasks[0]?.validation.map((entry) => entry.errorSummary)).toEqual([
      'attempt one',
      'attempt two',
      'attempt three',
    ]);
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

  it('records an escalated task without changed-file evidence when no files changed', () => {
    const task = makeTask();
    const ledger = createEvidenceLedger({ sessionId: 'sess-1', feature: 'feat', tasks: [task] });
    const updated = recordRetryOrEscalationEvidence({
      ledger,
      task,
      status: 'escalated',
      escalated: true,
    });

    expect(updated.tasks[0]?.changedFiles).toEqual([]);
    expect(updated.tasks[0]?.observedEvidence).not.toContain(`diff written for ${task.file}`);
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
