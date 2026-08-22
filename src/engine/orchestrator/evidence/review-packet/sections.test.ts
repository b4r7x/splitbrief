import { describe, it, expect } from 'vitest';
import { makeTask } from '#testing/helpers/factories/task.js';
import { createInitialState } from '../../../../core/state/machine.js';
import { createEvidenceLedger } from '../../../../core/evidence/ledger-state.js';
import type { EvidenceLedger } from '../../../../core/schemas/evidence.js';
import { taskId } from '../../../../core/schemas/task.js';
import type { WorkflowState } from '../../../../core/schemas/workflow.js';
import type { ReviewPacket } from '../../../../core/schemas/review-packet.js';
import { ReviewPacketSchema } from '../../../../core/schemas/review-packet.js';
import { buildValidation } from './sections.js';
import { renderReviewPacketMarkdown } from './render.js';
import { makeUsage } from '#testing/helpers/factories/summary.js';

function stateWith(...tasks: ReturnType<typeof makeTask>[]): WorkflowState {
  return { ...createInitialState('feat'), tasks };
}

function packetWithValidation(validation: ReviewPacket['validation']): ReviewPacket {
  return ReviewPacketSchema.parse({
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
    validation,
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
      estimatedCostSavings: null,
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
  });
}

function ledgerWithEvidence(
  task: ReturnType<typeof makeTask>,
  expectedEvidence: string[],
  observedEvidence: string[],
): EvidenceLedger {
  const ledger = createEvidenceLedger({ sessionId: 's', feature: 'feat', tasks: [task] });
  return {
    ...ledger,
    tasks: ledger.tasks.map((entry) => ({ ...entry, expectedEvidence, observedEvidence })),
  };
}

describe('buildValidation missingExpectedEvidence matching', () => {
  it('keeps a long expectation missing when only a terse observed substring is present', () => {
    const task = makeTask({ id: 'T001' });
    const ledger = ledgerWithEvidence(
      task,
      ['handles concurrent writes without corrupting the ledger'],
      ['ledger'],
    );

    const result = buildValidation(stateWith(task), ledger);

    expect(result.tasks[0]?.missingExpectedEvidence).toEqual([
      'handles concurrent writes without corrupting the ledger',
    ]);
    expect(result.missingEvidenceWarnings).toEqual([
      'T001 missing expected evidence: handles concurrent writes without corrupting the ledger',
    ]);
  });

  it('satisfies an expectation only when an observed item contains the full expected text', () => {
    const task = makeTask({ id: 'T001' });
    const ledger = ledgerWithEvidence(
      task,
      ['test passes'],
      ['integration test passes after retry'],
    );

    const result = buildValidation(stateWith(task), ledger);

    expect(result.tasks[0]?.missingExpectedEvidence).toEqual([]);
    expect(result.missingEvidenceWarnings).toEqual([]);
  });
});

describe('buildValidation baselineExempt carry-through', () => {
  it('carries the baselineExempt flag from the ledger entry and omits it when absent', () => {
    const task = makeTask({ id: 'T001' });
    const base = ledgerWithEvidence(task, [], []);
    const ledger: EvidenceLedger = {
      ...base,
      tasks: base.tasks.map((entry) => ({
        ...entry,
        validation: [
          { stage: 'typecheck', passed: false, baselineExempt: true },
          { stage: 'lint', passed: true },
        ],
      })),
    };

    const result = buildValidation(stateWith(task), ledger);

    expect(result.tasks[0]?.validation).toEqual([
      { stage: 'typecheck', passed: false, baselineExempt: true },
      { stage: 'lint', passed: true },
    ]);
  });

  it('keeps the raw passed count and names the exempt stage in the rendered packet', () => {
    const packet = packetWithValidation({
      summary: { passed: 1, failed: 1, skipped: 0, escalated: 0 },
      tasks: [
        {
          taskId: taskId('T001'),
          title: 'Add feature',
          status: 'done',
          validation: [
            { stage: 'typecheck', passed: true },
            { stage: 'lint', passed: false, baselineExempt: true },
          ],
          expectedEvidence: [],
          observedEvidence: [],
          missingExpectedEvidence: [],
        },
      ],
      finalReviewEvidenceStatus: null,
      missingEvidenceWarnings: [],
    });

    const rendered = renderReviewPacketMarkdown(packet);

    expect(rendered).toContain('T001 done: 1/2 validation stages passed');
    expect(rendered).toContain('1 baseline-exempt: lint');
  });
});
