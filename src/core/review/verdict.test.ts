import { describe, expect, it } from 'vitest';
import type { ReviewVerdict } from '../schemas/review.js';
import { taskId } from '../schemas/task.js';
import { deriveReviewOutcome, type ReviewScope, verdictCoverageErrors } from './verdict.js';

type Finding = ReviewVerdict['findings'][number];

const scope: ReviewScope = { taskIds: ['T001'], criterionIds: ['C1'] };

function task(id: string, plan: 'met' | 'partial' | 'missed' = 'met') {
  return { id: taskId(id), plan, note: '' };
}

function criterion(id: string, status: 'pass' | 'fail' | 'unverified' = 'pass') {
  return { id, status, evidence: 'Checked against the implementation diff' };
}

function finding(overrides: Partial<Finding> = {}): Finding {
  return {
    id: 'F1',
    kind: 'defect',
    severity: 'minor',
    taskId: null,
    file: null,
    line: null,
    text: 'The greeting drops an empty name',
    acceptance: null,
    checkIds: null,
    criterionId: null,
    ...overrides,
  };
}

function makeVerdict(overrides: Partial<ReviewVerdict> = {}): ReviewVerdict {
  return {
    tasks: [task('T001')],
    criteria: [criterion('C1')],
    findings: [],
    ...overrides,
  };
}

function verification(
  entries: [string, 'pass' | 'fail' | 'unverified'][] = [],
): ReadonlyMap<string, 'pass' | 'fail' | 'unverified'> {
  return new Map(entries);
}

describe('verdictCoverageErrors', () => {
  it('accepts a verdict that covers the scope once', () => {
    expect(verdictCoverageErrors(makeVerdict(), scope)).toEqual([]);
  });

  it('reports an omitted, duplicated or unknown task or criterion id', () => {
    const cases: ReviewVerdict[] = [
      makeVerdict({ tasks: [] }),
      makeVerdict({ tasks: [task('T001'), task('T001')] }),
      makeVerdict({ tasks: [task('T001'), task('T099')] }),
      makeVerdict({ criteria: [] }),
      makeVerdict({ criteria: [criterion('C1'), criterion('C1')] }),
      makeVerdict({ criteria: [criterion('C1'), criterion('C9')] }),
    ];
    for (const verdict of cases) {
      expect(verdictCoverageErrors(verdict, scope).length).toBeGreaterThan(0);
    }
  });

  it('reports a non-met task or failed criterion no blocking finding names', () => {
    const errors = verdictCoverageErrors(
      makeVerdict({ tasks: [task('T001', 'partial')], criteria: [criterion('C1', 'fail')] }),
      scope,
    );
    expect(errors.some((error) => error.includes('T001'))).toBe(true);
    expect(errors.some((error) => error.includes('C1'))).toBe(true);
    const named = makeVerdict({
      tasks: [task('T001', 'partial')],
      criteria: [criterion('C1', 'fail')],
      findings: [finding({ severity: 'blocking', taskId: 'T001', criterionId: 'C1' })],
    });
    expect(verdictCoverageErrors(named, scope)).toEqual([]);
  });

  it('reports a duplicated finding id and an unverified finding with no target', () => {
    const duplicated = makeVerdict({ findings: [finding(), finding({ text: 'Another' })] });
    expect(verdictCoverageErrors(duplicated, scope).some((error) => error.includes('F1'))).toBe(
      true,
    );
    const orphan = makeVerdict({
      findings: [finding({ kind: 'unverified', severity: 'blocking' })],
    });
    expect(verdictCoverageErrors(orphan, scope).some((error) => error.includes('F1'))).toBe(true);
    const byCheck = makeVerdict({
      findings: [finding({ kind: 'unverified', severity: 'blocking', checkIds: ['K1'] })],
    });
    expect(verdictCoverageErrors(byCheck, scope)).toEqual([]);
    const byCriterion = makeVerdict({
      findings: [finding({ kind: 'unverified', severity: 'blocking', criterionId: 'C1' })],
    });
    expect(verdictCoverageErrors(byCriterion, scope)).toEqual([]);
  });
});

describe('deriveReviewOutcome', () => {
  it('keeps a finding check separate from a criterion with the same id', () => {
    const verdict = makeVerdict({
      criteria: [criterion('C1', 'unverified')],
      findings: [finding({ id: 'C1', kind: 'unverified', checkIds: ['K2'] })],
    });
    const outcome = deriveReviewOutcome(verdict, scope, verification([['finding:C1', 'pass']]));
    expect(outcome.kind).toBe('fail');
    expect(outcome.unverifiedCriteria).toEqual(['C1']);
    expect(outcome.blocking).toEqual([]);
    expect(outcome.minor).toHaveLength(1);
  });
  it('derives pass from a complete verdict with no findings', () => {
    const outcome = deriveReviewOutcome(makeVerdict(), scope, verification());
    expect(outcome.kind).toBe('pass');
    expect(outcome.blocking).toEqual([]);
    expect(outcome.minor).toEqual([]);
    expect(outcome.unverifiedCriteria).toEqual([]);
    expect(outcome.coverageErrors).toEqual([]);
  });

  it('derives pass-with-notes from a complete all-met verdict with only minor findings', () => {
    const outcome = deriveReviewOutcome(
      makeVerdict({ findings: [finding()] }),
      scope,
      verification(),
    );
    expect(outcome.kind).toBe('pass-with-notes');
    expect(outcome.minor).toHaveLength(1);
    expect(outcome.blocking).toEqual([]);
  });

  it('fails an omitted, duplicated or unknown task or criterion id', () => {
    const cases: ReviewVerdict[] = [
      makeVerdict({ tasks: [] }),
      makeVerdict({ tasks: [task('T001'), task('T001')] }),
      makeVerdict({ tasks: [task('T001'), task('T099')] }),
      makeVerdict({ criteria: [] }),
      makeVerdict({ criteria: [criterion('C1'), criterion('C1')] }),
      makeVerdict({ criteria: [criterion('C1'), criterion('C9')] }),
    ];
    for (const verdict of cases) {
      const outcome = deriveReviewOutcome(verdict, scope, verification());
      expect(outcome.kind).toBe('fail');
      expect(outcome.coverageErrors.length).toBeGreaterThan(0);
    }
  });

  it('fails an unverified criterion unless verification passed it', () => {
    const verdict = makeVerdict({ criteria: [criterion('C1', 'unverified')] });
    const pending = deriveReviewOutcome(verdict, scope, verification());
    expect(pending.kind).toBe('fail');
    expect(pending.unverifiedCriteria).toEqual(['C1']);
    const passed = deriveReviewOutcome(verdict, scope, verification([['criterion:C1', 'pass']]));
    expect(passed.kind).toBe('pass');
    expect(passed.unverifiedCriteria).toEqual([]);
    const failed = deriveReviewOutcome(verdict, scope, verification([['criterion:C1', 'fail']]));
    expect(failed.kind).toBe('fail');
    expect(failed.unverifiedCriteria).toEqual([]);
  });

  it('fails a blocking finding and an unverified finding until verification passed it', () => {
    const blocking = deriveReviewOutcome(
      makeVerdict({ findings: [finding({ severity: 'blocking' })] }),
      scope,
      verification(),
    );
    expect(blocking.kind).toBe('fail');
    expect(blocking.blocking).toHaveLength(1);

    const unverified = makeVerdict({
      findings: [finding({ kind: 'unverified', severity: 'blocking', checkIds: ['K1'] })],
    });
    const pending = deriveReviewOutcome(unverified, scope, verification());
    expect(pending.kind).toBe('fail');
    expect(pending.blocking).toHaveLength(1);
    const failedCheck = deriveReviewOutcome(
      unverified,
      scope,
      verification([['finding:F1', 'fail']]),
    );
    expect(failedCheck.kind).toBe('fail');
    expect(failedCheck.blocking).toHaveLength(1);
    const passedCheck = deriveReviewOutcome(
      unverified,
      scope,
      verification([['finding:F1', 'pass']]),
    );
    expect(passedCheck.kind).toBe('pass-with-notes');
    expect(passedCheck.blocking).toEqual([]);
    expect(passedCheck.minor).toHaveLength(1);
  });
});
