import type { ReviewVerdict } from '../schemas/review/verdict.js';
import { isTaskCompleted } from '../schemas/task.js';
import { type WorkflowState, fixCyclesOf } from '../schemas/workflow/state.js';

export type Finding = ReviewVerdict['findings'][number];

export type ReviewScope = {
  kind: 'task' | 'final';
  taskIds: readonly string[];
  criterionIds: readonly string[];
};

export function reviewScopeFor(state: WorkflowState, kind: 'final' | 'task'): ReviewScope {
  if (kind === 'final') {
    return {
      kind,
      taskIds: state.tasks.map((task) => task.id),
      criterionIds: state.plan?.criteria.map((criterion) => criterion.id) ?? [],
    };
  }
  return {
    kind,
    taskIds: state.tasks.filter((task) => isTaskCompleted(task.status)).map((task) => task.id),
    criterionIds: dueCriterionIds(state),
  };
}

/**
 * A correction or an answer is pending on the review this cycle already judged: that review runs
 * again on the same candidate, without running its checks first.
 */
export function reviewsAgain(
  state: WorkflowState,
  kind: ReviewScope['kind'],
  afterTaskId?: string,
): boolean {
  const review = state.review;
  return (
    state.pendingTriage !== undefined &&
    review !== undefined &&
    (review.scope ?? 'final') === kind &&
    review.afterTaskId === afterTaskId &&
    review.cycle === fixCyclesOf(state).used
  );
}

export function findingInReviewScope(finding: Finding, scope: ReviewScope): boolean {
  if (scope.kind === 'final') return true;
  return (
    (finding.taskId !== null || finding.criterionId !== null) &&
    (finding.taskId === null || scope.taskIds.includes(finding.taskId)) &&
    (finding.criterionId === null || scope.criterionIds.includes(finding.criterionId))
  );
}

export function dueCriterionIds(state: WorkflowState, completingTaskId?: string): string[] {
  return (state.plan?.criteria ?? [])
    .filter((criterion) =>
      state.tasks
        .filter((task) => (task.criteria ?? []).includes(criterion.id))
        .every((task) => task.id === completingTaskId || isTaskCompleted(task.status)),
    )
    .map((criterion) => criterion.id);
}

export function verdictCoverageErrors(verdict: ReviewVerdict, scope: ReviewScope): string[] {
  const errors: string[] = [];
  const scopeTaskIds = new Set(scope.taskIds);
  const reportedTaskIds = new Set<string>();
  for (const task of verdict.tasks) {
    if (reportedTaskIds.has(task.id)) errors.push(`Task ${task.id} is reported more than once.`);
    reportedTaskIds.add(task.id);
  }
  for (const id of scope.taskIds) {
    if (!reportedTaskIds.has(id)) errors.push(`Task ${id} is missing from the verdict.`);
  }
  for (const task of verdict.tasks) {
    if (!scopeTaskIds.has(task.id)) errors.push(`Task ${task.id} is not part of the plan.`);
  }
  const scopeCriterionIds = new Set(scope.criterionIds);
  const reportedCriterionIds = new Set<string>();
  for (const criterion of verdict.criteria) {
    if (reportedCriterionIds.has(criterion.id)) {
      errors.push(`Criterion ${criterion.id} is reported more than once.`);
    }
    reportedCriterionIds.add(criterion.id);
  }
  for (const id of scope.criterionIds) {
    if (!reportedCriterionIds.has(id)) errors.push(`Criterion ${id} is missing from the verdict.`);
  }
  for (const criterion of verdict.criteria) {
    if (!scopeCriterionIds.has(criterion.id)) {
      errors.push(`Criterion ${criterion.id} is not part of the plan.`);
    }
  }
  const reportedFindingIds = new Set<string>();
  for (const finding of verdict.findings) {
    if (reportedFindingIds.has(finding.id)) {
      errors.push(`Finding ${finding.id} is reported more than once.`);
    }
    reportedFindingIds.add(finding.id);
  }
  const blocking = verdict.findings.filter(
    (finding) => finding.severity === 'blocking' && findingInReviewScope(finding, scope),
  );
  for (const task of verdict.tasks) {
    if (task.plan === 'met') continue;
    if (!blocking.some((finding) => finding.taskId === task.id)) {
      errors.push(`Task ${task.id} is ${task.plan} and no blocking finding names it.`);
    }
  }
  for (const criterion of verdict.criteria) {
    if (criterion.status !== 'fail') continue;
    if (!blocking.some((finding) => finding.criterionId === criterion.id)) {
      errors.push(`Criterion ${criterion.id} failed and no blocking finding names it.`);
    }
  }
  for (const finding of verdict.findings) {
    if (finding.kind !== 'unverified' || !findingInReviewScope(finding, scope)) continue;
    const checkIds = finding.checkIds ?? [];
    if (checkIds.length === 0 && finding.criterionId === null) {
      errors.push(`Finding ${finding.id} is unverified and names no check or criterion.`);
    }
  }
  return errors;
}
