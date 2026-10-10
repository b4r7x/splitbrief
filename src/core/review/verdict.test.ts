import { describe, expect, it } from 'vitest';
import type { ReviewVerdict } from '../schemas/review.js';
import { taskId } from '../schemas/task.js';
import type { ReviewRecord } from '../schemas/workflow.js';
import {
  deriveReviewOutcome,
  findingInReviewScope,
  reviewOutcomeOf,
  type ReviewScope,
  verdictCoverageErrors,
} from './verdict.js';

type Finding = ReviewVerdict['findings'][number];

const scope: ReviewScope = { kind: 'final', taskIds: ['T001'], criterionIds: ['C1'] };
const taskScope: ReviewScope = {
  kind: 'task',
  taskIds: ['T001', 'T002', 'T003', 'T004'],
  criterionIds: ['C1', 'C2', 'C3', 'C4', 'C5', 'C6', 'C7', 'C8', 'C9'],
};

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
  it('records findings outside a task review scope and keeps scoped blockers', () => {
    const outside = [
      finding({ id: 'F1', severity: 'blocking', text: 'C10/C11 not implemented' }),
      finding({ id: 'F3', severity: 'blocking', taskId: 'T005' }),
      finding({ id: 'F4', severity: 'blocking', taskId: 'T004', criterionId: 'C10' }),
    ];
    const scoped = finding({
      id: 'F2',
      severity: 'blocking',
      taskId: 'T004',
      criterionId: 'C6',
      text: 'Time-zone tests miss an offset',
    });
    const verdict = makeVerdict({
      tasks: taskScope.taskIds.map((id) => task(id)),
      criteria: taskScope.criterionIds.map((id) => criterion(id)),
      findings: [...outside, scoped],
    });
    const failed = deriveReviewOutcome(verdict, taskScope, verification());
    expect(failed.outOfScope).toEqual(outside);
    expect(failed.blocking).toEqual([scoped]);
    expect(failed.kind).toBe('fail');
    expect(failed.coverageErrors).toEqual([]);

    const noted = deriveReviewOutcome({ ...verdict, findings: outside }, taskScope, verification());
    expect(noted.outOfScope).toEqual(outside);
    expect(noted.blocking).toEqual([]);
    expect(noted.kind).toBe('pass-with-notes');
    expect(noted.coverageErrors).toEqual([]);
  });

  it('classifies task scope before unverified findings', () => {
    const outside = [
      finding({ id: 'F1', kind: 'unverified', severity: 'blocking' }),
      finding({ id: 'F3', kind: 'unverified', checkIds: ['K1'] }),
    ];
    const scoped = finding({
      id: 'F2',
      kind: 'unverified',
      severity: 'blocking',
      taskId: 'T004',
      criterionId: 'C6',
    });
    const verdict = makeVerdict({
      tasks: taskScope.taskIds.map((id) => task(id)),
      criteria: taskScope.criterionIds.map((id) => criterion(id)),
      findings: [...outside, scoped],
    });
    for (const status of [undefined, 'pass', 'fail'] as const) {
      const checked = verification(
        status === undefined
          ? []
          : [
              ['finding:F1', status],
              ['finding:F2', status],
              ['finding:F3', status],
            ],
      );
      const outcome = deriveReviewOutcome(verdict, taskScope, checked);
      expect(outcome.outOfScope).toEqual(outside);
      expect(outcome.coverageErrors).toEqual([]);
      expect(outcome.blocking).toEqual(status === 'pass' ? [] : [scoped]);
      expect(outcome.minor).toEqual(status === 'pass' ? [scoped] : []);
      expect(outcome.kind).toBe(status === 'pass' ? 'pass-with-notes' : 'fail');
    }
  });

  it('an out-of-scope finding cannot answer a failed scoped result', () => {
    const verdict = makeVerdict({
      tasks: taskScope.taskIds.map((id) => task(id, id === 'T004' ? 'partial' : 'met')),
      criteria: taskScope.criterionIds.map((id) => criterion(id, id === 'C6' ? 'fail' : 'pass')),
      findings: [finding({ severity: 'blocking' })],
    });
    expect(verdictCoverageErrors(verdict, taskScope)).toEqual([
      'Task T004 is partial and no blocking finding names it.',
      'Criterion C6 failed and no blocking finding names it.',
    ]);
    const namesBoth = {
      ...verdict,
      findings: [
        finding({ id: 'F1', severity: 'blocking', taskId: 'T004', criterionId: 'C10' }),
        finding({ id: 'F2', severity: 'blocking', taskId: 'T005', criterionId: 'C6' }),
      ],
    };
    expect(verdictCoverageErrors(namesBoth, taskScope)).toEqual(
      verdictCoverageErrors(verdict, taskScope),
    );
  });

  it('a stored task review derives the same outcome', () => {
    const verdict = makeVerdict({
      tasks: taskScope.taskIds.map((id) => task(id)),
      criteria: taskScope.criterionIds.map((id) => criterion(id)),
      findings: [
        finding({ severity: 'blocking' }),
        finding({
          id: 'F2',
          kind: 'unverified',
          severity: 'blocking',
          taskId: 'T004',
          criterionId: 'C6',
        }),
      ],
    });
    const record: ReviewRecord = {
      scope: 'task',
      cycle: 0,
      verdict,
      outcome: 'pass-with-notes',
      verification: [{ id: 'finding:F2', status: 'pass', output: '' }],
      at: '2026-10-10T10:00:00.000Z',
    };
    expect(reviewOutcomeOf(record)).toEqual(
      deriveReviewOutcome(verdict, taskScope, verification([['finding:F2', 'pass']])),
    );
    const legacy = reviewOutcomeOf({ ...record, scope: undefined });
    expect(legacy.kind).toBe('fail');
    expect(legacy.blocking.map((entry) => entry.id)).toEqual(['F1']);
    expect(legacy.outOfScope).toEqual([]);
  });

  it('the final review still blocks a missing criterion and a null-id defect', () => {
    const finalScope: ReviewScope = {
      kind: 'final',
      taskIds: ['T005'],
      criterionIds: ['C10'],
    };
    const missing = finding({ severity: 'blocking', criterionId: 'C10' });
    const verdict = makeVerdict({
      tasks: [task('T005')],
      criteria: [criterion('C10', 'fail')],
      findings: [missing],
    });
    const failed = deriveReviewOutcome(verdict, finalScope, verification());
    expect(failed.kind).toBe('fail');
    expect(failed.blocking).toEqual([missing]);
    expect(failed.outOfScope).toEqual([]);
    expect(failed.coverageErrors).toEqual([]);
    expect(verdictCoverageErrors({ ...verdict, criteria: [] }, finalScope)).toEqual([
      'Criterion C10 is missing from the verdict.',
    ]);
    const defect = finding({ severity: 'blocking' });
    const unnamed = deriveReviewOutcome(
      { ...verdict, criteria: [criterion('C10')], findings: [defect] },
      finalScope,
      verification(),
    );
    expect(unnamed.kind).toBe('fail');
    expect(unnamed.blocking).toEqual([defect]);
    expect(unnamed.outOfScope).toEqual([]);
  });

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

describe('findingInReviewScope', () => {
  it.each([
    { taskId: 'T004', criterionId: null, included: true },
    { taskId: null, criterionId: 'C6', included: true },
    { taskId: 'T004', criterionId: 'C6', included: true },
    { taskId: 'T004', criterionId: 'C10', included: false },
    { taskId: 'T005', criterionId: 'C6', included: false },
    { taskId: 'T005', criterionId: null, included: false },
    { taskId: null, criterionId: null, included: false },
  ])('checks task $taskId and criterion $criterionId against both ids', (entry) => {
    const candidate = finding({ ...entry, checkIds: ['K1'] });
    expect(findingInReviewScope(candidate, taskScope)).toBe(entry.included);
    expect(findingInReviewScope(candidate, scope)).toBe(true);
  });
});
