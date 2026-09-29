import { describe, expect, it } from 'vitest';
import { REVIEW_PACKET_VERSION, ReviewPacketSchema } from './review-packet.js';
import { ReviewPacketSummarySchema } from './summary.js';
import { makeUsage } from '#testing/helpers/factories/summary.js';

describe('review packet schema verdict fields', () => {
  it('parses a packet written before the verdict fields and yields their defaults', () => {
    const packet = ReviewPacketSchema.parse(packetBeforeVerdictFields());

    expect(packet.version).toBe(REVIEW_PACKET_VERSION);
    expect(packet.finalReview.verdict).toBeNull();
    expect(packet.finalReview.criteriaPassed).toBe(0);
    expect(packet.finalReview.criteriaFailed).toBe(0);
    expect(packet.finalReview.findingCounts).toEqual({ critical: 0, warning: 0, note: 0 });
  });

  it('parses a summary rollup written before the verdict fields and yields their defaults', () => {
    const rollup = ReviewPacketSummarySchema.parse({
      jsonPath: 'review-packet.json',
      markdownPath: 'review-packet.md',
      generatedAt: '2026-08-05T00:00:00.000Z',
      finalReviewStatus: 'written',
      driftPassed: null,
      evidenceValidatedTasks: 0,
      evidenceTotalTasks: 1,
      missingArtifactCount: 0,
    });

    expect(rollup.finalReviewVerdict).toBeNull();
    expect(rollup.finalReviewFindingCounts).toEqual({ critical: 0, warning: 0, note: 0 });
  });

  it('keeps the reviewer cost line through a packet round-trip', () => {
    const base = ReviewPacketSchema.parse(packetBeforeVerdictFields());
    const packet = ReviewPacketSchema.parse({
      ...base,
      cost: {
        tokenUsage: makeUsage(),
        costBreakdown: {
          actualPlannerCost: 1,
          actualImplementerCost: 0.5,
          actualReviewerCost: 0.25,
          totalActualCost: 1.75,
          isActualReviewerCostKnown: true,
        },
        taskRouting: [],
        routingWarnings: [],
      },
    });

    const breakdown = packet.cost.costBreakdown;
    if (!breakdown) throw new Error('expected a cost breakdown');
    expect(breakdown.actualReviewerCost).toBe(0.25);
    expect(breakdown.isActualReviewerCostKnown).toBe(true);
    expect(breakdown.totalActualCost).toBe(1.75);
  });
});

function packetBeforeVerdictFields(): unknown {
  return {
    version: 1,
    sessionId: 's',
    generatedAt: '2026-08-05T00:00:00.000Z',
    run: {
      sessionId: 's',
      feature: 'feat',
      mode: null,
      phase: 'complete',
      planner: { tool: null, model: null },
      implementer: { tool: null, model: null },
      startedAt: null,
      completedAt: null,
      totalTimeMs: null,
      totalTasks: 1,
      completedLocally: 1,
      escalated: 0,
      skipped: 0,
      failed: 0,
    },
    readiness: {
      path: 'readiness.json',
      present: true,
      status: null,
      nextAction: null,
      blockerCount: null,
      warningCount: null,
      checks: [],
    },
    changes: {
      changedFiles: [],
      expectedFiles: [],
      outOfScopeFiles: [],
      taskFiles: [],
      diffReference: 'Review the working tree with `git diff`.',
    },
    checkpoints: {
      items: [],
      latestRunCheckpoint: null,
      preFinalReview: null,
      runLedger: {
        path: 'checkpoint-run-ledger.json',
        present: false,
        accepted: null,
        rejected: null,
        runSnapshotIds: [],
        runSnapshotKinds: {},
        latestSnapshotId: null,
      },
      safety: {
        hashGuarded: true,
        conflictsSkippedByDefault: true,
        forceOverwritesConflicts: true,
        partialRestoreExpected: true,
        excludedPaths: [],
        text: {
          hashGuarded: '',
          conflictsSkippedByDefault: '',
          forceOverwritesConflicts: '',
          partialRestoreExpected: '',
          excludedPaths: '',
        },
      },
    },
    recoveryDecisions: {
      sourceArtifacts: [],
      events: [],
      currentIssue: null,
      selectedActions: [],
      outcomes: [],
      unresolvedRisks: [],
    },
    validation: {
      summary: { passed: 0, failed: 0, skipped: 0, escalated: 0 },
      tasks: [],
      finalReviewEvidenceStatus: null,
      missingEvidenceWarnings: [],
    },
    evidence: {
      path: null,
      present: false,
      briefHash: null,
      finalReview: null,
      approvals: [],
      rejections: [],
    },
    drift: {
      path: null,
      present: false,
      passed: null,
      score: null,
      errorCount: 0,
      warningCount: 0,
      changedFiles: [],
      expectedFiles: [],
      findings: [],
      findingsBySeverity: { info: [], warning: [], error: [] },
      briefHash: null,
      chainSummary: {
        path: 'drift-chains.json',
        present: false,
        emittedChainCount: 0,
        topChain: null,
        briefQuality: {
          path: 'brief-quality.json',
          present: false,
          passed: null,
          score: null,
          errorCount: 0,
          warningCount: 0,
        },
      },
      briefQuality: {
        path: 'brief-quality.json',
        present: false,
        passed: null,
        score: null,
        errorCount: 0,
        warningCount: 0,
      },
    },
    escalations: {
      retries: [],
      escalatedTasks: [],
      skippedTasks: [],
      failedTasks: [],
      warnings: [],
    },
    cost: {
      tokenUsage: makeUsage(),
      costBreakdown: null,
      taskRouting: [],
      routingWarnings: [],
    },
    finalReview: {
      path: 'review.md',
      status: 'skipped',
      evidenceStatus: null,
      statusText: 'No final review was recorded.',
      excerpt: null,
    },
    reviewerChecklist: [],
    missingArtifacts: [],
  };
}

describe('review packet seat identity kinds', () => {
  it('reads a packet whose run section predates kinds with the kinds absent', () => {
    const packet = ReviewPacketSchema.parse(packetBeforeVerdictFields());

    expect(packet.run.planner).not.toHaveProperty('kind');
    expect(packet.run.implementer).not.toHaveProperty('kind');
  });

  it('keeps runner kinds through a packet round trip and accepts a null unknown', () => {
    const base = ReviewPacketSchema.parse(packetBeforeVerdictFields());
    const packet = ReviewPacketSchema.parse({
      ...base,
      run: {
        ...base.run,
        planner: { ...base.run.planner, kind: 'cli' },
        implementer: { ...base.run.implementer, kind: null },
      },
    });

    expect(packet.run.planner.kind).toBe('cli');
    expect(packet.run.implementer.kind).toBeNull();
  });

  it('rejects a kind outside the runner kinds', () => {
    const base = ReviewPacketSchema.parse(packetBeforeVerdictFields());

    expect(() =>
      ReviewPacketSchema.parse({
        ...base,
        run: { ...base.run, planner: { ...base.run.planner, kind: 'local' } },
      }),
    ).toThrow();
  });
});
