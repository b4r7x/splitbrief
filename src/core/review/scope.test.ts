import { describe, expect, it } from 'vitest';
import { makeImplState } from '#testing/helpers/factories/workflow-state.js';
import {
  criterion,
  finding,
  makeVerdict,
  scope,
  task,
  taskScope,
} from '#testing/helpers/review-verdict.js';
import type { ReviewVerdict } from '../schemas/review/verdict.js';
import { taskId } from '../schemas/task.js';
import type { ReviewRecord } from '../schemas/workflow/review-record.js';
import { findingInReviewScope, reviewsAgain, verdictCoverageErrors } from './scope.js';

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

describe('reviewsAgain', () => {
  const judged = (overrides: Partial<ReviewRecord> = {}): ReviewRecord => ({
    scope: 'task',
    afterTaskId: taskId('T002'),
    cycle: 2,
    verdict: makeVerdict(),
    outcome: 'fail',
    verification: [],
    at: '2026-10-20T10:00:00.000Z',
    ...overrides,
  });
  const pendingTriage = {
    inputs: [
      {
        id: 'U1',
        kind: 'defect' as const,
        source: 'user' as const,
        text: 'Rename beta',
        file: null,
      },
    ],
  };
  const fixCycles = { used: 2, notes: [] };

  it.each([
    {
      name: 'a pending correction on this task review',
      overrides: {},
      kind: 'task' as const,
      anchor: 'T002',
      again: true,
    },
    {
      name: 'a task review of another brief',
      overrides: {},
      kind: 'task' as const,
      anchor: 'T003',
      again: false,
    },
    {
      name: 'the final review after a task review',
      overrides: {},
      kind: 'final' as const,
      anchor: undefined,
      again: false,
    },
    {
      name: 'a review of an earlier cycle',
      overrides: { cycle: 1 },
      kind: 'task' as const,
      anchor: 'T002',
      again: false,
    },
    {
      name: 'a pending correction on the final review',
      overrides: { scope: 'final' as const, afterTaskId: undefined },
      kind: 'final' as const,
      anchor: undefined,
      again: true,
    },
    {
      name: 'an older record without a scope',
      overrides: { scope: undefined, afterTaskId: undefined },
      kind: 'final' as const,
      anchor: undefined,
      again: true,
    },
  ])('answers $again for $name', ({ overrides, kind, anchor, again }) => {
    const state = makeImplState([], { review: judged(overrides), pendingTriage, fixCycles });
    expect(reviewsAgain(state, kind, anchor)).toBe(again);
  });

  it('answers false when nothing is pending', () => {
    const state = makeImplState([], { review: judged(), fixCycles });
    expect(reviewsAgain(state, 'task', 'T002')).toBe(false);
  });
});
