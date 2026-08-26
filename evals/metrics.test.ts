import { describe, expect, it } from 'vitest';
import { breakdownEntry, makeRunMetrics, makeSummary } from './eval-factories.js';
import {
  collectGreenRunAggregates,
  collectRunMetrics,
  compareScenario,
  type ReviewMetrics,
} from './metrics.js';
import { aggregateComparisons } from './runner.js';
import { ReviewVerdictSchema, type Summary } from '../src/core/schemas/summary.js';
import { taskId } from '../src/core/schemas/task.js';
import type { EngineEvent } from '../src/engine/events/types.js';

describe('outcome metrics', () => {
  it('counts a task as first-pass only when it completed locally with zero retries', () => {
    const summary = makeSummary(0, {
      totalTasks: 4,
      completedByLocal: 1,
      escalatedToPlanner: 2,
      taskBreakdown: [
        breakdownEntry('T001', 'local', 0),
        breakdownEntry('T002', 'local', 2),
        breakdownEntry('T003', 'escalated-hint', 0),
        breakdownEntry('T004', 'escalated-full', 1),
      ],
    });

    const metrics = collectRunMetrics({
      scenarioId: 'fake',
      mode: 'baseline',
      summary,
      events: [],
      qualityResults: [],
      durationMs: 100,
      sessionArtifactsDir: null,
    });

    expect(metrics.outcome.firstPassTasks).toBe(1);
    expect(metrics.outcome.retriedTasks).toBe(2);
    expect(metrics.outcome.escalatedTasks).toBe(2);
  });

  it('counts every escalation attempt from the events while the summary counts only completions', () => {
    const escalations: EngineEvent[] = [
      { type: 'escalate', ts: 1, phase: 'implementing', taskId: taskId('T001'), tier: 1 },
      { type: 'escalate', ts: 2, phase: 'implementing', taskId: taskId('T001'), tier: 2 },
    ];

    const metrics = collectRunMetrics({
      scenarioId: 'fake',
      mode: 'baseline',
      summary: makeSummary(0.1, { escalatedToPlanner: 0 }),
      events: escalations,
      qualityResults: [{ passed: true, detail: 'ok' }],
      durationMs: 100,
      sessionArtifactsDir: null,
    });
    const aggregate = aggregateComparisons([
      compareScenario({
        scenarioId: 'fake',
        scenarioName: 'Fake scenario',
        baseline: metrics,
        routed: makeRunMetrics({ mode: 'routed', cost: 0.04 }),
      }),
    ]);

    expect(metrics.outcome.escalationAttempts).toBe(2);
    expect(metrics.outcome.escalatedTasks).toBe(0);
    expect(aggregate.totalEscalations).toBe(2);
    expect(aggregate.totalEscalationCompletions).toBe(0);
  });

  it('divides first-pass tasks by the run total, not by completed tasks', () => {
    const summary = makeSummary(0, {
      totalTasks: 4,
      completedByLocal: 2,
      taskBreakdown: [breakdownEntry('T001', 'local', 0), breakdownEntry('T002', 'local', 0)],
    });

    const metrics = collectRunMetrics({
      scenarioId: 'fake',
      mode: 'baseline',
      summary,
      events: [],
      qualityResults: [],
      durationMs: 100,
      sessionArtifactsDir: null,
    });

    expect(metrics.outcome.firstPassTasks).toBe(2);
    expect(metrics.outcome.firstPassRate).toBe(0.5);
  });

  it('takes failed and skipped counts from the summary when the total exceeds breakdown plus failed plus skipped', () => {
    const summary = makeSummary(0, {
      totalTasks: 10,
      completedByLocal: 3,
      skipped: 2,
      failed: 2,
      taskBreakdown: [
        breakdownEntry('T001', 'local', 0),
        breakdownEntry('T002', 'local', 1),
        breakdownEntry('T003', 'local', 0),
      ],
    });

    const metrics = collectRunMetrics({
      scenarioId: 'fake',
      mode: 'baseline',
      summary,
      events: [],
      qualityResults: [],
      durationMs: 100,
      sessionArtifactsDir: null,
    });

    expect(metrics.outcome.failedTasks).toBe(2);
    expect(metrics.outcome.skippedTasks).toBe(2);
  });

  it('treats an absent task breakdown as an empty list, never as zero total tasks', () => {
    const summary = makeSummary(0, { totalTasks: 2, completedByLocal: 0 });

    const metrics = collectRunMetrics({
      scenarioId: 'fake',
      mode: 'baseline',
      summary,
      events: [],
      qualityResults: [],
      durationMs: 100,
      sessionArtifactsDir: null,
    });

    expect(metrics.outcome.totalTasks).toBe(2);
    expect(metrics.outcome.firstPassTasks).toBe(0);
    expect(metrics.outcome.firstPassRate).toBe(0);
  });

  it('reports the routed-minus-baseline first-pass difference in percentage points', () => {
    const baseline = collectRunMetrics({
      scenarioId: 'fake',
      mode: 'baseline',
      summary: makeSummary(0, {
        totalTasks: 4,
        completedByLocal: 1,
        taskBreakdown: [breakdownEntry('T001', 'local', 0)],
      }),
      events: [],
      qualityResults: [],
      durationMs: 100,
      sessionArtifactsDir: null,
    });
    const routed = collectRunMetrics({
      scenarioId: 'fake',
      mode: 'routed',
      summary: makeSummary(0, {
        totalTasks: 2,
        completedByLocal: 1,
        taskBreakdown: [breakdownEntry('T001', 'local', 0)],
      }),
      events: [],
      qualityResults: [],
      durationMs: 100,
      sessionArtifactsDir: null,
    });

    const comparison = compareScenario({
      scenarioId: 'fake',
      scenarioName: 'Fake scenario',
      baseline,
      routed,
    });

    expect(baseline.outcome.firstPassRate).toBe(0.25);
    expect(routed.outcome.firstPassRate).toBe(0.5);
    expect(comparison.firstPassRateDeltaPercent).toBe(25);
  });
});

describe('review metrics', () => {
  function summaryWithReviewPacket(
    verdict: ReviewMetrics['verdict'],
    findingCounts: { critical: number; warning: number; note: number },
    overrides: Partial<Summary> = {},
  ): Summary {
    return makeSummary(0, {
      ...overrides,
      reviewPacket: {
        jsonPath: 'review-packet.json',
        markdownPath: 'review-packet.md',
        generatedAt: '2026-08-05T00:00:00.000Z',
        finalReviewStatus: 'written',
        finalReviewVerdict: verdict,
        finalReviewFindingCounts: findingCounts,
        driftPassed: true,
        evidenceValidatedTasks: 1,
        evidenceTotalTasks: 1,
        missingArtifactCount: 0,
      },
    });
  }

  it('reports the review findings and marks the run validation-green', () => {
    const metrics = collectRunMetrics({
      scenarioId: 'fake',
      mode: 'baseline',
      summary: summaryWithReviewPacket('fail', { critical: 1, warning: 2, note: 3 }),
      events: [],
      qualityResults: [],
      durationMs: 100,
      sessionArtifactsDir: null,
    });

    expect(metrics.review.verdict).toBe('fail');
    expect(metrics.review.criticalFindings).toBe(1);
    expect(metrics.review.warningFindings).toBe(2);
    expect(metrics.review.noteFindings).toBe(3);
    expect(metrics.review.validationGreen).toBe(true);
  });

  it('still reports the same findings on a run with a failure, with validation-green false', () => {
    const metrics = collectRunMetrics({
      scenarioId: 'fake',
      mode: 'baseline',
      summary: summaryWithReviewPacket(
        'pass_with_notes',
        { critical: 0, warning: 1, note: 3 },
        { failed: 1 },
      ),
      events: [],
      qualityResults: [],
      durationMs: 100,
      sessionArtifactsDir: null,
    });

    expect(metrics.review.verdict).toBe('pass_with_notes');
    expect(metrics.review.criticalFindings).toBe(0);
    expect(metrics.review.warningFindings).toBe(1);
    expect(metrics.review.noteFindings).toBe(3);
    expect(metrics.review.validationGreen).toBe(false);
  });

  it('carries every verdict the review schema admits', () => {
    const carried = ReviewVerdictSchema.options.map(
      (verdict) =>
        collectRunMetrics({
          scenarioId: 'fake',
          mode: 'baseline',
          summary: summaryWithReviewPacket(verdict, { critical: 0, warning: 0, note: 0 }),
          events: [],
          qualityResults: [],
          durationMs: 100,
          sessionArtifactsDir: null,
        }).review.verdict,
    );

    expect(carried).toEqual([...ReviewVerdictSchema.options]);
  });

  it('yields an unknown verdict and zero counts when there is no review packet', () => {
    const metrics = collectRunMetrics({
      scenarioId: 'fake',
      mode: 'baseline',
      summary: makeSummary(0),
      events: [],
      qualityResults: [],
      durationMs: 100,
      sessionArtifactsDir: null,
    });

    expect(metrics.review.verdict).toBeNull();
    expect(metrics.review.criticalFindings).toBe(0);
    expect(metrics.review.warningFindings).toBe(0);
    expect(metrics.review.noteFindings).toBe(0);
  });

  it('excludes zero-task runs from the green-run aggregate', () => {
    const greenWithFindings = collectRunMetrics({
      scenarioId: 'fake',
      mode: 'baseline',
      summary: summaryWithReviewPacket('pass_with_notes', { critical: 2, warning: 0, note: 0 }),
      events: [],
      qualityResults: [],
      durationMs: 100,
      sessionArtifactsDir: null,
    });
    const greenWithoutFindings = collectRunMetrics({
      scenarioId: 'fake',
      mode: 'routed',
      summary: summaryWithReviewPacket('pass', { critical: 0, warning: 0, note: 0 }),
      events: [],
      qualityResults: [],
      durationMs: 100,
      sessionArtifactsDir: null,
    });
    const greenZeroTaskWithFindings = collectRunMetrics({
      scenarioId: 'fake',
      mode: 'baseline',
      summary: summaryWithReviewPacket(
        'pass_with_notes',
        { critical: 1, warning: 0, note: 0 },
        { totalTasks: 0, completedByLocal: 0 },
      ),
      events: [],
      qualityResults: [],
      durationMs: 100,
      sessionArtifactsDir: null,
    });
    const failedWithFindings = collectRunMetrics({
      scenarioId: 'fake',
      mode: 'routed',
      summary: summaryWithReviewPacket('fail', { critical: 3, warning: 0, note: 0 }, { failed: 1 }),
      events: [],
      qualityResults: [],
      durationMs: 100,
      sessionArtifactsDir: null,
    });

    const comparisons = [
      compareScenario({
        scenarioId: 'green',
        scenarioName: 'Green',
        baseline: greenWithFindings,
        routed: greenWithoutFindings,
      }),
      compareScenario({
        scenarioId: 'zero-task',
        scenarioName: 'Zero-task',
        baseline: greenZeroTaskWithFindings,
        routed: failedWithFindings,
      }),
    ];

    const aggregates = collectGreenRunAggregates(comparisons);

    expect(aggregates.greenRunsWithFindings).toBe(1);
    expect(aggregates.greenRunsCriticalFindings).toBe(2);
  });
});
