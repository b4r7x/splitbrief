import { describe, expect, it } from 'vitest';
import { renderSessionHtml } from './html-renderer.js';
import type { ExportData } from './types.js';

function makeExportData(overrides: Partial<ExportData> = {}): ExportData {
  return {
    sessionId: '2026-05-04-test-feature',
    feature: 'add user auth',
    completedAt: '2026-05-04T12:00:00Z',
    isComplete: true,
    summary: {
      feature: 'add user auth',
      totalTasks: 5,
      completedByLocal: 4,
      escalatedToPlanner: 1,
      skipped: 0,
      failed: 0,
      totalTime: 120_000,
      tokenUsage: {
        plannerInput: 50_000,
        plannerOutput: 10_000,
        implementerInput: 20_000,
        implementerOutput: 5_000,
        escalationInput: 0,
        escalationOutput: 0,
      },
      estimatedCostSavings: '$1.03',
      escalationRate: 0.2,
      costBreakdown: {
        hypotheticalCost: 1.2,
        actualPlannerCost: 0.15,
        actualImplementerCost: 0.02,
        totalActualCost: 0.17,
        savingsAmount: 1.03,
        savingsPercentage: 85.8,
        localCompletionRate: 0.8,
      },
      plannerTool: 'claude-code',
      plannerModel: 'claude-opus-4-5',
      implementerTool: 'ollama',
      implementerModel: 'qwen2.5-coder:7b',
      mode: 'standard',
      phaseTimings: {
        researching: 30_000,
        specifying: 20_000,
        planning: 15_000,
        implementing: 50_000,
        'final-review': 5_000,
      },
    },
    ...overrides,
  };
}

describe('renderSessionHtml', () => {
  it('produces HTML with DOCTYPE', () => {
    const html = renderSessionHtml(makeExportData());
    expect(html).toMatch(/^<!DOCTYPE html>/);
  });

  it('includes feature name in title', () => {
    const html = renderSessionHtml(makeExportData());
    expect(html).toContain('<title>diptych — add user auth</title>');
  });

  it('includes hero savings when cost data exists', () => {
    const html = renderSessionHtml(makeExportData());
    expect(html).toContain('86%');
    expect(html).toContain('$0.17');
  });

  it('omits hero savings when no cost breakdown', () => {
    const html = renderSessionHtml(
      makeExportData({
        summary: {
          ...makeExportData().summary,
          costBreakdown: undefined,
        },
      }),
    );
    expect(html).not.toContain('saved');
  });

  it('includes evidence section when evidence data present', () => {
    const html = renderSessionHtml(
      makeExportData({
        evidence: {
          totalTasks: 5,
          tasksWithValidationEvidence: 4,
          escalatedTasks: 1,
          failedTasks: 0,
        },
      }),
    );
    expect(html).toContain('4/5');
  });

  it('omits evidence section when no evidence data', () => {
    const html = renderSessionHtml(makeExportData());
    expect(html).not.toContain('Evidence');
  });

  it('escapes HTML in feature name', () => {
    const html = renderSessionHtml(
      makeExportData({ feature: 'fix <script>alert("xss")</script>' }),
    );
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
  });

  it('includes inline CSS', () => {
    const html = renderSessionHtml(makeExportData());
    expect(html).toContain('<style>');
    expect(html).not.toContain('<link');
  });

  it('includes phase timing bars', () => {
    const html = renderSessionHtml(makeExportData());
    expect(html).toContain('researching');
    expect(html).toContain('implementing');
  });
});
