import { describe, expect, it } from 'vitest';
import {
  buildEvidenceSummary,
  buildRejectionContext,
  recordFinalReviewEvidence,
} from './reporting.js';
import { createEvidenceLedger } from '../../../core/evidence/ledger-state.js';
import { recordLocalTaskEvidence } from './task.js';
import { makeTask } from '#testing/helpers/factories/task.js';
import type { ValidationResult } from '../validation/result.js';

function passing(stage: 'typecheck' | 'lint' | 'test'): ValidationResult {
  return { passed: true, stage };
}

describe('recordFinalReviewEvidence', () => {
  it('marks final review as written', () => {
    const task = makeTask();
    const ledger = createEvidenceLedger({ sessionId: 'sess-1', feature: 'feat', tasks: [task] });
    const local = recordLocalTaskEvidence({
      ledger,
      task,
      status: 'done',
      validation: [passing('typecheck')],
    });
    const updated = recordFinalReviewEvidence({ ledger: local, status: 'written' });
    expect(updated.finalReview?.status).toBe('written');
    expect(updated.tasks[0]?.observedEvidence).toContain('final review written');
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
    const local = recordLocalTaskEvidence({
      ledger,
      task,
      status: 'done',
      validation: [passing('typecheck')],
    });
    const summary = buildEvidenceSummary(local);
    expect(summary.totalTasks).toBe(1);
    expect(summary.tasksWithValidationEvidence).toBe(1);
  });
});
