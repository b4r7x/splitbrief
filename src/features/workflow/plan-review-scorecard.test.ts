import { describe, expect, it } from 'vitest';
import type { TaskId } from '../../core/schemas/task.js';
import type { BriefQualityIssue, BriefQualityReport } from '../../engine/spec/brief-quality.js';
import type { PlanTaskReviewMetadata } from '../../stores/workflow/plan-editor.js';
import { makeTask } from '#testing/helpers/factories/task.js';
import { buildPlanReviewScorecard } from './plan-review-scorecard.js';

function quality(issues: BriefQualityIssue[] = []): BriefQualityReport {
  return {
    version: 1,
    passed: issues.every((issue) => issue.severity !== 'error'),
    score: issues.length === 0 ? 1 : 0.5,
    issues,
  };
}

function issue(
  task: TaskId,
  code: BriefQualityIssue['code'],
  severity: BriefQualityIssue['severity'] = 'error',
): BriefQualityIssue {
  return {
    taskId: task,
    severity,
    code,
    message: code,
  };
}

function readyMetadata(
  taskIdValue: TaskId,
  overrides: Partial<PlanTaskReviewMetadata> = {},
): PlanTaskReviewMetadata {
  return {
    taskId: taskIdValue,
    workerProfile: 'local-qwen',
    contextFit: 'fits',
    estimatedTokens: 1200,
    validationStatus: 'pass',
    risk: 'low',
    ...overrides,
  };
}

function metadataMap(items: PlanTaskReviewMetadata[]): ReadonlyMap<string, PlanTaskReviewMetadata> {
  return new Map(items.map((item) => [item.taskId, item]));
}

describe('buildPlanReviewScorecard', () => {
  it('returns zeroed buckets in stable display order for an empty plan', () => {
    const scorecard = buildPlanReviewScorecard([], null, new Map());

    expect(scorecard.buckets.map((bucket) => bucket.bucket)).toEqual([
      'ready',
      'routingPending',
      'splitOverflow',
      'riskyTight',
      'staleConflict',
      'missingChecks',
    ]);
    expect(scorecard.buckets.map((bucket) => bucket.label)).toEqual([
      'ready 0',
      'routing pending 0',
      'split/overflow 0',
      'risky/tight 0',
      'stale/conflict 0',
      'missing checks 0',
    ]);
    expect(
      scorecard.buckets.every((bucket) => bucket.count === 0 && bucket.taskIds.length === 0),
    ).toBe(true);
  });

  it('marks only fully reviewed tasks ready', () => {
    const ready = makeTask({ id: 'T001', evidence: ['vitest passes'] });
    const missingEvidence = makeTask({ id: 'T002', evidence: [] });
    const qualityError = makeTask({ id: 'T003', evidence: ['reviewed'] });
    const validationFailed = makeTask({ id: 'T004', evidence: ['reviewed'] });
    const inferredValidationReady = makeTask({ id: 'T005', evidence: ['reviewed'] });

    const scorecard = buildPlanReviewScorecard(
      [ready, missingEvidence, qualityError, validationFailed, inferredValidationReady],
      quality([issue(qualityError.id, 'missing_scope')]),
      metadataMap([
        readyMetadata(ready.id),
        readyMetadata(missingEvidence.id),
        readyMetadata(qualityError.id),
        readyMetadata(validationFailed.id, { validationStatus: 'fail' }),
        readyMetadata(inferredValidationReady.id, { validationStatus: undefined }),
      ]),
    );

    expect(scorecard.ready.taskIds).toEqual([ready.id, inferredValidationReady.id]);
    expect(scorecard.ready.count).toBe(2);
    expect(scorecard.missingChecks.taskIds).toEqual([missingEvidence.id]);
    expect(scorecard.riskyTight.taskIds).toEqual([validationFailed.id]);
  });

  it('counts routing gaps without making pending tasks ready', () => {
    const noMetadata = makeTask({ id: 'T001', evidence: ['reviewed'] });
    const unknownFit = makeTask({ id: 'T002', evidence: ['reviewed'] });
    const missingWorker = makeTask({ id: 'T003', evidence: ['reviewed'] });
    const missingTokens = makeTask({ id: 'T004', evidence: ['reviewed'] });
    const modifyNoStatus = makeTask({ id: 'T005', action: 'modify', evidence: ['reviewed'] });
    const validationPending = makeTask({ id: 'T006', evidence: ['reviewed'] });

    const scorecard = buildPlanReviewScorecard(
      [noMetadata, unknownFit, missingWorker, missingTokens, modifyNoStatus, validationPending],
      quality(),
      metadataMap([
        readyMetadata(unknownFit.id, { contextFit: undefined }),
        readyMetadata(missingWorker.id, { workerProfile: undefined }),
        readyMetadata(missingTokens.id, { estimatedTokens: undefined }),
        readyMetadata(modifyNoStatus.id),
        readyMetadata(validationPending.id, { validationStatus: 'pending' }),
      ]),
    );

    expect(scorecard.routingPending.taskIds).toEqual([
      noMetadata.id,
      unknownFit.id,
      missingWorker.id,
      missingTokens.id,
      modifyNoStatus.id,
      validationPending.id,
    ]);
    expect(scorecard.ready.count).toBe(0);
  });

  it('allows warning buckets to overlap while keeping ready exclusive', () => {
    const overflow = makeTask({ id: 'T001', evidence: ['reviewed'] });
    const noCapable = makeTask({ id: 'T002', evidence: ['reviewed'] });
    const multiFile = makeTask({ id: 'T003', evidence: ['reviewed'] });
    const tight = makeTask({ id: 'T004', evidence: ['reviewed'] });
    const staleMissingCode = makeTask({ id: 'T005', action: 'modify', evidence: ['reviewed'] });
    const conflictNoTests = makeTask({ id: 'T006', tests: [], evidence: [] });

    const scorecard = buildPlanReviewScorecard(
      [overflow, noCapable, multiFile, tight, staleMissingCode, conflictNoTests],
      quality([
        issue(multiFile.id, 'multi_file_task'),
        issue(conflictNoTests.id, 'missing_validation'),
        issue(conflictNoTests.id, 'missing_evidence'),
      ]),
      metadataMap([
        readyMetadata(overflow.id, { contextFit: 'overflow', workerProfile: undefined }),
        readyMetadata(noCapable.id, {
          workerProfile: undefined,
          routingReason: 'No capable implementer profile can fit this task prompt',
        }),
        readyMetadata(multiFile.id),
        readyMetadata(tight.id, { contextFit: 'tight', risk: 'high', validationStatus: 'warn' }),
        readyMetadata(staleMissingCode.id, { estimateStatus: 'missing-current-code' }),
        readyMetadata(conflictNoTests.id, {
          conflict: { kind: 'current-task-conflict', files: ['src/hello.ts'] },
        }),
      ]),
    );

    expect(scorecard.splitOverflow.taskIds).toEqual([overflow.id, noCapable.id, multiFile.id]);
    expect(scorecard.riskyTight.taskIds).toEqual([tight.id, staleMissingCode.id]);
    expect(scorecard.staleConflict.taskIds).toEqual([staleMissingCode.id, conflictNoTests.id]);
    expect(scorecard.missingChecks.taskIds).toEqual([conflictNoTests.id]);
    expect(scorecard.ready.count).toBe(0);
  });

  it('treats unavailable current code and stale metadata as stale routing context problems', () => {
    const stale = makeTask({ id: 'T001', evidence: ['reviewed'] });
    const unavailable = makeTask({ id: 'T002', action: 'modify', evidence: ['reviewed'] });
    const missing = makeTask({ id: 'T003', action: 'modify', evidence: ['reviewed'] });

    const scorecard = buildPlanReviewScorecard(
      [stale, unavailable, missing],
      quality(),
      metadataMap([
        readyMetadata(stale.id, { stale: true }),
        readyMetadata(unavailable.id, { estimateStatus: 'current-code-unavailable' }),
        readyMetadata(missing.id, { estimateStatus: 'missing-current-code' }),
      ]),
    );

    expect(scorecard.routingPending.taskIds).toEqual([stale.id, unavailable.id, missing.id]);
    expect(scorecard.staleConflict.taskIds).toEqual([stale.id, unavailable.id, missing.id]);
    expect(scorecard.ready.count).toBe(0);
  });

  it('counts brief-quality validation and evidence issues as missing checks', () => {
    const missingValidation = makeTask({ id: 'T001', evidence: ['reviewed'] });
    const vagueValidation = makeTask({ id: 'T002', evidence: ['reviewed'] });
    const missingEvidence = makeTask({ id: 'T003', evidence: ['reviewed'] });

    const scorecard = buildPlanReviewScorecard(
      [missingValidation, vagueValidation, missingEvidence],
      quality([
        issue(missingValidation.id, 'missing_validation'),
        issue(vagueValidation.id, 'vague_validation'),
        issue(missingEvidence.id, 'missing_evidence'),
      ]),
      metadataMap([
        readyMetadata(missingValidation.id),
        readyMetadata(vagueValidation.id),
        readyMetadata(missingEvidence.id),
      ]),
    );

    expect(scorecard.missingChecks.taskIds).toEqual([
      missingValidation.id,
      vagueValidation.id,
      missingEvidence.id,
    ]);
    expect(scorecard.ready.count).toBe(0);
  });

  it('counts non-atomic warning issues as split or overflow without requiring an error-level issue', () => {
    const nonAtomic = makeTask({ id: 'T001', evidence: ['reviewed'] });

    const scorecard = buildPlanReviewScorecard(
      [nonAtomic],
      quality([issue(nonAtomic.id, 'missing_type_definitions', 'warning')]),
      metadataMap([readyMetadata(nonAtomic.id)]),
    );

    expect(scorecard.splitOverflow.taskIds).toEqual([nonAtomic.id]);
    expect(scorecard.ready.count).toBe(0);
  });
});
