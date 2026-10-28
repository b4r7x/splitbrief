import type { ReviewVerdict, TriageInput, TriageResult } from '../schemas/review.js';
import { isTaskCompleted } from '../schemas/task.js';
import { fixCyclesOf, type ReviewRecord, type WorkflowState } from '../schemas/workflow.js';
import { oneLineDisplayText } from '../../utils/display-text.js';
import { countNoun } from '../../utils/pluralize.js';

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

export type ReviewOutcome = {
  kind: 'pass' | 'pass-with-notes' | 'fail';
  blocking: Finding[];
  minor: Finding[];
  outOfScope: Finding[];
  unverifiedCriteria: string[];
  coverageErrors: string[];
  criteria: ReviewVerdict['criteria'];
  redInputs: RedInput[];
};

export type RedInput = Pick<TriageInput, 'id' | 'text'>;

/** What fails a review: each blocking finding, then each red input that still blocks. */
export function blockingEntries(
  outcome: Pick<ReviewOutcome, 'blocking' | 'redInputs'>,
): { id: string; text: string }[] {
  return [...outcome.blocking, ...outcome.redInputs].map(({ id, text }) => ({ id, text }));
}

/** A failed check or Apply input; a correction or an answer from the user is never red. */
function isRedInput(input: TriageInput): boolean {
  return input.source === 'check' || input.source === 'apply';
}

/** The red inputs that still block a review: each one the answer does not reject. */
export function blockingRedInputs(
  inputs: readonly TriageInput[],
  fixWork: TriageResult,
): TriageInput[] {
  const rejected = new Set(fixWork.rejected.map((entry) => entry.findingId));
  return inputs.filter((input) => isRedInput(input) && !rejected.has(input.id));
}

export type SetAside = { id: string; reason: string };

/** The red inputs the answer rejects, each with the reviewer's reason. */
export function setAsideInputs(inputs: readonly TriageInput[], fixWork: TriageResult): SetAside[] {
  const red = new Set(inputs.filter(isRedInput).map((input) => input.id));
  return fixWork.rejected
    .filter((entry) => red.has(entry.findingId))
    .map((entry) => ({ id: entry.findingId, reason: entry.reason }));
}

export function setAsideLabel(id: string): string {
  return `Set aside ${id}`;
}

export function setAsideLine(entry: SetAside): string {
  return `${setAsideLabel(entry.id)}: ${oneLineDisplayText(entry.reason)}`;
}

export function verificationKey(kind: 'criterion' | 'finding', id: string): string {
  return `${kind}:${id}`;
}

export function reviewOutcomeOf(record: ReviewRecord): ReviewOutcome {
  return deriveReviewOutcome(
    record.verdict,
    {
      kind: record.scope ?? 'final',
      taskIds: record.verdict.tasks.map((task) => task.id),
      criterionIds: record.verdict.criteria.map((criterion) => criterion.id),
    },
    new Map(record.verification.map((entry) => [entry.id, entry.status])),
    record.redInputs,
  );
}

export function reviewOutcomeWord(outcome: ReviewOutcome): 'pass' | 'pass_with_notes' | 'fail' {
  return outcome.kind === 'pass-with-notes' ? 'pass_with_notes' : outcome.kind;
}

export function reviewFindingCounts(outcome: ReviewOutcome) {
  return {
    critical: outcome.blocking.length + outcome.redInputs.length,
    warning: outcome.minor.length,
    note: outcome.outOfScope.length,
  };
}

/** The finding tallies the closed run and the review packet spell the same way: a minor and an out-of-scope finding are both notes. */
export function formatFindingCounts(
  counts: Readonly<{ critical: number; warning: number; note: number }>,
): string {
  return `${counts.critical} blocking, ${countNoun(counts.warning + counts.note, 'note')}`;
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

export function deriveReviewOutcome(
  verdict: ReviewVerdict,
  scope: ReviewScope,
  verification: ReadonlyMap<string, 'pass' | 'fail' | 'unverified'>,
  redInputs: readonly RedInput[] = [],
): ReviewOutcome {
  const coverageErrors = verdictCoverageErrors(verdict, scope);
  const unverifiedCriteria: string[] = [];
  const criteria = verdict.criteria.map((criterion) => {
    const status =
      criterion.status === 'unverified'
        ? (verification.get(verificationKey('criterion', criterion.id)) ?? 'unverified')
        : criterion.status;
    if (status === 'unverified') unverifiedCriteria.push(criterion.id);
    return { ...criterion, status };
  });
  const blocking: Finding[] = [];
  const minor: Finding[] = [];
  const outOfScope: Finding[] = [];
  for (const finding of verdict.findings) {
    if (!findingInReviewScope(finding, scope)) {
      outOfScope.push(finding);
      continue;
    }
    const verified =
      finding.kind === 'unverified' &&
      verification.get(verificationKey('finding', finding.id)) === 'pass';
    if (finding.severity === 'blocking' && !verified) blocking.push(finding);
    else minor.push(finding);
  }
  const failed =
    coverageErrors.length > 0 ||
    unverifiedCriteria.length > 0 ||
    blocking.length > 0 ||
    redInputs.length > 0 ||
    verdict.tasks.some((task) => task.plan !== 'met') ||
    criteria.some((criterion) => criterion.status !== 'pass');
  if (failed)
    return {
      kind: 'fail',
      blocking,
      minor,
      outOfScope,
      unverifiedCriteria,
      coverageErrors,
      criteria,
      redInputs: redInputs.map(({ id, text }) => ({ id, text })),
    };
  return {
    kind: minor.length === 0 && outOfScope.length === 0 ? 'pass' : 'pass-with-notes',
    blocking,
    minor,
    outOfScope,
    unverifiedCriteria,
    coverageErrors,
    criteria,
    redInputs: [],
  };
}
