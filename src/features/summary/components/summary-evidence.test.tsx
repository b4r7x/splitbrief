import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { renderFeature } from '../../../../testing/helpers/ink.js';
import { SummaryEvidence } from './summary-evidence.js';
import {
  createEvidenceLedger,
  recordFinalReviewEvidence,
  recordLocalTaskEvidence,
  recordRetryOrEscalationEvidence,
  writeEvidenceLedger,
} from '../../../engine/orchestrator/evidence.js';
import { makeTask } from '../../../../testing/helpers/factories/task.js';
import { configStore } from '../../../stores/project/config.js';
import { terminalSizeStore } from '../../../stores/ui/terminal-size.js';
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
    plannerInput: 0, plannerOutput: 0,
    implementerInput: 0, implementerOutput: 0,
    escalationInput: 0, escalationOutput: 0,
  },
  estimatedCostSavings: '$0',
  escalationRate: 0,
  costBreakdown: {
    hypotheticalCost: 0, actualPlannerCost: 0, actualImplementerCost: 0,
    totalActualCost: 0, savingsAmount: 0, savingsPercentage: 0,
    localCompletionRate: 0, hasSavingsEstimate: false,
  },
  plannerTool: 'p', implementerTool: 'i',
};

describe('SummaryEvidence', () => {
  let dir: string;
  let prevProjectDir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'summary-evidence-'));
    prevProjectDir = configStore.get().projectDir;
    configStore.__testReset({ projectDir: dir });
  });
  afterEach(() => {
    configStore.__testReset({ projectDir: prevProjectDir });
    rmSync(dir, { recursive: true, force: true });
  });

  it('renders nothing when summary has no evidenceSummary', () => {
    const ui = renderFeature(<SummaryEvidence summary={baseSummary} />);
    expect(ui.lastFrame() ?? '').toBe('');
    ui.unmount();
  });

  it('renders rollup line and per-task evidence from the ledger on disk', () => {
    const sessionId = 's1';
    const a = makeTask({ id: 'T001', title: 'Add hello module', file: 'src/hello.ts' });
    const b = makeTask({ id: 'T002', title: 'Escalated thing', file: 'src/world.ts' });
    let ledger = createEvidenceLedger({ sessionId, feature: 'demo', mode: 'standard', tasks: [a, b] });
    ledger = recordLocalTaskEvidence({
      ledger, task: a, status: 'done', method: 'local',
      validation: [{ passed: true, stage: 'tsc' }, { passed: true, stage: 'lint' }, { passed: true, stage: 'test' }],
    });
    ledger = recordRetryOrEscalationEvidence({
      ledger, task: b, status: 'escalated', escalated: true,
      validation: [{ passed: true, stage: 'tsc' }],
    });
    ledger = recordFinalReviewEvidence({ ledger, status: 'written' });
    writeEvidenceLedger(dir, sessionId, ledger);

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
    const ui = renderFeature(<SummaryEvidence summary={summary} sessionId={sessionId} />);
    const frame = ui.lastFrame() ?? '';
    expect(frame).toContain('Evidence');
    expect(frame).toContain('2/2 validated');
    expect(frame).toContain('1 escalated');
    expect(frame).toContain('T001');
    expect(frame).toContain('Add hello module');
    expect(frame).toContain('tsc,lint,test');
    expect(frame).toContain('task reached done');
    expect(frame).toContain('T002');
    expect(frame).toContain('task reached escalated');
    expect(frame).toContain('final review: written');
    ui.unmount();
  });

  it('long titles are truncated with an ellipsis glyph', () => {
    const longTitle = 'A'.repeat(120);
    const task = makeTask({ id: 'T001', title: longTitle, tests: [] });
    let ledger = createEvidenceLedger({ sessionId: 's1', feature: 'demo', mode: 'standard', tasks: [task] });
    ledger = recordLocalTaskEvidence({
      ledger, task, status: 'done', method: 'local',
      validation: [{ passed: true, stage: 'tsc' }],
    });
    const summary: Summary = {
      ...baseSummary,
      evidenceSummary: { path: 'evidence.json', totalTasks: 1, tasksWithValidationEvidence: 1, escalatedTasks: 0, failedTasks: 0 },
    };
    terminalSizeStore.__testReset({ isSmall: false });
    const ui = renderFeature(<SummaryEvidence summary={summary} ledger={ledger} />);
    const frame = ui.lastFrame() ?? '';
    ui.unmount();
    terminalSizeStore.__testReset();
    expect(frame).toContain('\u2026');
    expect(frame).not.toContain(longTitle);
  });

  it('wide layout truncates titles more than small layout for a 22-char title', () => {
    // wide: flexDirection row, title gets titleWidth - 6 = 26 - 6 = 20 chars
    // small: flexDirection column, title gets 24 chars
    const title22 = 'B'.repeat(22);
    const task = makeTask({ id: 'T001', title: title22, tests: [] });
    let ledger = createEvidenceLedger({ sessionId: 's1', feature: 'demo', mode: 'standard', tasks: [task] });
    ledger = recordLocalTaskEvidence({
      ledger, task, status: 'done', method: 'local',
      validation: [{ passed: true, stage: 'tsc' }],
    });
    const summary: Summary = {
      ...baseSummary,
      evidenceSummary: { path: 'evidence.json', totalTasks: 1, tasksWithValidationEvidence: 1, escalatedTasks: 0, failedTasks: 0 },
    };

    terminalSizeStore.__testReset({ isSmall: false });
    const wide = renderFeature(<SummaryEvidence summary={summary} ledger={ledger} />);
    const wideFrame = wide.lastFrame() ?? '';
    wide.unmount();

    terminalSizeStore.__testReset({ isSmall: true });
    const small = renderFeature(<SummaryEvidence summary={summary} ledger={ledger} />);
    const smallFrame = small.lastFrame() ?? '';
    small.unmount();

    terminalSizeStore.__testReset();

    // wide: 22 > 20 limit → truncated
    expect(wideFrame).toContain('\u2026');
    expect(wideFrame).not.toContain(title22);
    // small: 22 ≤ 24 limit → not truncated
    expect(smallFrame).toContain(title22);
  });
});
