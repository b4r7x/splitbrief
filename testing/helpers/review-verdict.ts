import type { ReviewScope } from '../../src/core/review/scope.js';
import type { ReviewVerdict } from '../../src/core/schemas/review/verdict.js';
import { taskId } from '../../src/core/schemas/task.js';

export type Finding = ReviewVerdict['findings'][number];

export const scope: ReviewScope = { kind: 'final', taskIds: ['T001'], criterionIds: ['C1'] };
export const taskScope: ReviewScope = {
  kind: 'task',
  taskIds: ['T001', 'T002', 'T003', 'T004'],
  criterionIds: ['C1', 'C2', 'C3', 'C4', 'C5', 'C6', 'C7', 'C8', 'C9'],
};

export function task(id: string, plan: 'met' | 'partial' | 'missed' = 'met') {
  return { id: taskId(id), plan, note: '' };
}

export function criterion(id: string, status: 'pass' | 'fail' | 'unverified' = 'pass') {
  return { id, status, evidence: 'Checked against the implementation diff' };
}

export function finding(overrides: Partial<Finding> = {}): Finding {
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

export function makeVerdict(overrides: Partial<ReviewVerdict> = {}): ReviewVerdict {
  return {
    tasks: [task('T001')],
    criteria: [criterion('C1')],
    findings: [],
    ...overrides,
  };
}

export function verification(
  entries: [string, 'pass' | 'fail' | 'unverified'][] = [],
): ReadonlyMap<string, 'pass' | 'fail' | 'unverified'> {
  return new Map(entries);
}
