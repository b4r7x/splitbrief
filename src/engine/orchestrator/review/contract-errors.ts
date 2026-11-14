import {
  type Finding,
  type ReviewScope,
  findingInReviewScope,
} from '../../../core/review/scope.js';
import type { Plan, TaskSpec } from '../../../core/schemas/plan.js';
import type { TriageResult, TriageInput } from '../../../core/schemas/review/verdict.js';
import type { Task, Check } from '../../../core/schemas/task.js';
import { uniqueSorted } from '../../../utils/collections.js';
import { checkTaskIdentities } from '../../spec/plan/task-checks.js';
import { checkRegistry } from '../validation/checks/runner.js';

export function triageContractErrors(
  result: TriageResult,
  plan: Plan | undefined,
  findings: readonly Finding[],
  inputs: readonly TriageInput[],
  tasks: readonly Task[],
  reviewChecks: readonly Check[] | undefined,
  scope: ReviewScope,
): string[] {
  const errors: string[] = [];
  const blocking = findings.filter(
    (finding) => finding.severity === 'blocking' && finding.kind !== 'unverified',
  );
  if (result.ask === null) {
    const answered = new Map<string, number>();
    const count = (id: string): void => {
      answered.set(id, (answered.get(id) ?? 0) + 1);
    };
    for (const task of result.fixTasks) for (const id of task.findingIds) count(id);
    for (const rejected of result.rejected) count(rejected.findingId);
    // A blocking finding under a pending input's id is that input: the input's rule answers it.
    const inputIds = new Set(inputs.map((input) => input.id));
    for (const finding of blocking.filter(
      (finding) => findingInReviewScope(finding, scope) && !inputIds.has(finding.id),
    )) {
      const times = answered.get(finding.id) ?? 0;
      if (times === 0) {
        errors.push(`Blocking finding ${finding.id} is not fixed or rejected.`);
      } else if (times > 1) {
        errors.push(`Blocking finding ${finding.id} is answered more than once.`);
      }
    }
    for (const input of inputs) {
      const times = answered.get(input.id) ?? 0;
      // Fix tasks may share an input's failures: each task names it once, and nothing else does.
      const sharedByFixTasks =
        result.fixTasks.every(
          (task) => task.findingIds.filter((id) => id === input.id).length <= 1,
        ) && !result.rejected.some((entry) => entry.findingId === input.id);
      if (times === 0) {
        errors.push(`Pending input ${input.id} is not fixed or rejected.`);
      } else if (times > 1 && !sharedByFixTasks) {
        errors.push(`Pending input ${input.id} is answered more than once.`);
      }
    }
    const known = new Set([...blocking.map((finding) => finding.id), ...inputs.map((i) => i.id)]);
    for (const id of answered.keys()) {
      if (!known.has(id)) {
        errors.push(`${id} is not one of the blocking findings or pending inputs.`);
      }
    }
  }

  const pending = new Map(inputs.map((input) => [input.id, input]));
  for (const entry of result.rejected) {
    const input = pending.get(entry.findingId);
    if (input === undefined) errors.push(`Rejected ${entry.findingId} is not a pending input.`);
    else if (input.source === 'apply')
      errors.push(`Rejected ${entry.findingId} is an Apply conflict; it needs a fix task.`);
    if (entry.reason.trim() === '') errors.push(`Rejected ${entry.findingId} gives no reason.`);
  }

  const fixBatch = Math.max(1, ...tasks.map((task) => task.batch ?? 1)) + 1;
  errors.push(
    ...checkTaskIdentities(
      [...result.fixTasks.map((task) => ({ ...task, batch: fixBatch }))],
      tasks.map((task) => ({ ...task, batch: task.batch ?? 1 })),
    ).map((error) => error.message),
  );
  const checks = checkRegistry({ plan, tasks, reviewChecks });
  for (const task of result.fixTasks) {
    for (const id of task.findingIds) {
      const finding = findings.find((finding) => finding.id === id);
      if (finding !== undefined) {
        if (!findingInReviewScope(finding, scope)) {
          errors.push(
            `Finding ${id} is outside the task review scope and cannot be assigned to a fix task.`,
          );
        } else if (finding.kind === 'unverified' || finding.severity === 'minor') {
          errors.push(`Finding ${id} cannot be assigned to a fix task.`);
        }
      }
      for (const checkId of finding?.checkIds ?? []) {
        if (!checks.has(checkId)) {
          errors.push(`Finding ${id} names an unknown check: ${checkId}`);
        }
      }
    }
  }
  const criteria = new Set((plan?.criteria ?? []).map((criterion) => criterion.id));
  for (const task of result.fixTasks) {
    for (const criterionId of task.criteria) {
      if (scope.kind === 'task' && !scope.criterionIds.includes(criterionId)) {
        errors.push(
          `Fix task ${task.id} names criterion ${criterionId} outside the task review scope.`,
        );
      }
      if (!criteria.has(criterionId)) {
        errors.push(`Fix task ${task.id} names an unknown criterion: ${criterionId}`);
      }
    }
  }
  return errors;
}

/** A fix task never targets a file already changed when the run started that the run left alone. */
export function fixTaskTargetErrors(
  fixTasks: readonly TaskSpec[],
  userFiles: ReadonlySet<string>,
): string[] {
  return fixTasks.flatMap((task) =>
    uniqueSorted([
      ...task.suggestedFiles,
      ...(task.protectedOperations ?? []).map((operation) => operation.path),
    ])
      .filter((path) => userFiles.has(path))
      .map(
        (path) =>
          `Fix task ${task.id} targets ${path}: it was already changed when this run started, and this run did not change it.`,
      ),
  );
}
