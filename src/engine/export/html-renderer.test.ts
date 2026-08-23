import { describe, expect, it } from 'vitest';
import { renderSessionHtml } from './html-renderer.js';
import type { ExportData } from './types.js';
import { makeUsage } from '#testing/helpers/factories/summary.js';

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
      tokenUsage: makeUsage({
        plannerInput: 50_000,
        plannerOutput: 10_000,
        implementerInput: 20_000,
        implementerOutput: 5_000,
      }),
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
  it('renders the nominal complete report', () => {
    const html = renderSessionHtml(makeExportData());
    expect(html).toMatch(/^<!DOCTYPE html>/);
    expect(html).toContain('<title>SPLITBRIEF — add user auth</title>');
    expect(html).toContain('86%');
    expect(html).toContain('$0.17');
    expect(html).not.toContain('Evidence');
    expect(html).toContain('<style>');
    expect(html).not.toContain('<link');
    expect(html).toContain('researching');
    expect(html).toContain('implementing');
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
          href: 'evidence.json',
        },
      }),
    );
    expect(html).toContain('4/5');
  });

  it('links to the evidence href when it is a relative path', () => {
    const html = renderSessionHtml(
      makeExportData({
        evidence: {
          totalTasks: 5,
          tasksWithValidationEvidence: 4,
          escalatedTasks: 1,
          failedTasks: 0,
          href: '../session/evidence.json',
        },
      }),
    );
    expect(html).toContain('<a href="../session/evidence.json">../session/evidence.json</a>');
  });

  it('prints an absolute evidence href as text instead of a broken link', () => {
    const html = renderSessionHtml(
      makeExportData({
        evidence: {
          totalTasks: 5,
          tasksWithValidationEvidence: 4,
          escalatedTasks: 1,
          failedTasks: 0,
          href: '/tmp/session/evidence.json',
        },
      }),
    );
    expect(html).not.toContain('<a href="/tmp/session/evidence.json">');
    expect(html).toContain('<code>/tmp/session/evidence.json</code>');
  });

  it('escapes HTML in feature name', () => {
    const html = renderSessionHtml(
      makeExportData({ feature: 'fix <script>alert("xss")</script>' }),
    );
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
  });

  it('redacts secrets from the feature title and heading', () => {
    const html = renderSessionHtml(
      makeExportData({ feature: 'use sk-ant-aaaaaaaaaaaaaaaaaaaaaaaa for auth' }),
    );
    expect(html).not.toContain('sk-ant-aaaaaaaaaaaaaaaaaaaaaaaa');
    expect(html).toContain('<title>SPLITBRIEF — use sk-ant-***REDACTED*** for auth</title>');
    expect(html).toContain('<h1>use sk-ant-***REDACTED*** for auth</h1>');
  });
});
