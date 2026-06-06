import { describe, expect, it } from 'vitest';
import { renderFeature } from '#testing/helpers/ink.js';
import { SummaryEvidence } from './evidence.js';
import { createEvidenceLedger } from '../../../core/evidence/ledger.js';
import { recordFinalReviewEvidence } from '../../../engine/orchestrator/evidence/reporting.js';
import {
  recordLocalTaskEvidence,
  recordRetryOrEscalationEvidence,
} from '../../../engine/orchestrator/evidence/task.js';
import { makeTask } from '#testing/helpers/factories/task.js';
import type { Summary } from '../../../core/schemas/summary.js';

const baseSummary: Summary = {
  feature: 'demo',
  totalTasks: 0,
  completedByLocal: 0,
  escalatedToPlanner: 0,
  skipped: 0,
  failed: 0,
  totalTime: 0,
  tokenUsage: {
    plannerInput: 0,
    plannerOutput: 0,
    implementerInput: 0,
    implementerOutput: 0,
    escalationInput: 0,
    escalationOutput: 0,
  },
  estimatedCostSavings: '$0',
  escalationRate: 0,
  costBreakdown: {
    hypotheticalCost: 0,
    actualPlannerCost: 0,
    actualImplementerCost: 0,
    totalActualCost: 0,
    savingsAmount: 0,
    savingsPercentage: 0,
    localCompletionRate: 0,
    hasSavingsEstimate: false,
  },
  plannerTool: 'p',
  implementerTool: 'i',
};

describe('SummaryEvidence', () => {
  it('renders nothing when summary has no evidenceSummary', () => {
    const ui = renderFeature(<SummaryEvidence summary={baseSummary} />);
    expect(ui.lastFrame() ?? '').toBe('');
    ui.unmount();
  });

  it('renders the rollup line when ledger details are unavailable', () => {
    const summary: Summary = {
      ...baseSummary,
      evidenceSummary: {
        path: 'evidence.json',
        totalTasks: 2,
        tasksWithValidationEvidence: 1,
        escalatedTasks: 1,
        failedTasks: 0,
      },
    };

    const ui = renderFeature(<SummaryEvidence summary={summary} ledger={null} />);
    const frame = ui.lastFrame() ?? '';

    expect(frame).toContain('Evidence');
    expect(frame).toContain('1/2 validated');
    expect(frame).toContain('1 escalated');
    expect(frame).not.toContain('T001');

    ui.unmount();
  });

  it('renders per-task evidence from the loaded ledger prop', () => {
    const a = makeTask({ id: 'T001', title: 'Add hello module', file: 'src/hello.ts' });
    const b = makeTask({ id: 'T002', title: 'Escalated thing', file: 'src/world.ts' });
    let ledger = createEvidenceLedger({
      sessionId: 's1',
      feature: 'demo',
      mode: 'standard',
      tasks: [a, b],
    });
    ledger = recordLocalTaskEvidence({
      ledger,
      task: a,
      status: 'done',
      method: 'local',
      validation: [
        { passed: true, stage: 'typecheck' },
        { passed: true, stage: 'lint' },
        { passed: true, stage: 'test' },
      ],
    });
    ledger = recordRetryOrEscalationEvidence({
      ledger,
      task: b,
      status: 'escalated',
      escalated: true,
      validation: [{ passed: true, stage: 'typecheck' }],
    });
    ledger = recordFinalReviewEvidence({ ledger, status: 'written' });

    const summary: Summary = {
      ...baseSummary,
      evidenceSummary: {
        path: 'evidence.json',
        totalTasks: 2,
        tasksWithValidationEvidence: 2,
        escalatedTasks: 1,
        failedTasks: 0,
      },
    };
    const ui = renderFeature(<SummaryEvidence summary={summary} ledger={ledger} />);
    const frame = ui.lastFrame() ?? '';

    expect(frame).toContain('Evidence');
    expect(frame).toContain('2/2 validated');
    expect(frame).toContain('1 escalated');
    expect(frame).toContain('T001');
    expect(frame).toContain('Add hello module');
    expect(frame).toContain('typecheck,lint,test');
    expect(frame).toContain('task reached done');
    expect(frame).toContain('T002');
    expect(frame).toContain('task reached escalated');
    expect(frame).toContain('final review: written');
    ui.unmount();
  });
});
