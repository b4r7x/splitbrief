import { dueCriterionIds } from '../../../core/review/scope.js';
import { stuckAnswerErrors } from '../../../core/review/stuck.js';
import {
  type ConsultAnswer,
  type ConsultReason,
  CONSULT_ANSWER_JSON_SCHEMA,
  consultAnswerSchemaFor,
} from '../../../core/schemas/consult.js';
import type { Plan } from '../../../core/schemas/plan.js';
import type { Task } from '../../../core/schemas/task.js';
import type { WorkflowState } from '../../../core/schemas/workflow/state.js';
import { refusedCheckErrors } from '../../spec/plan/render-checks.js';
import { unconfiguredRenderCheckErrors } from '../../spec/plan/render-checks.js';
import { fixTaskTargetErrors } from '../review/contract-errors.js';
import { checkRegistry } from '../validation/checks/runner.js';
import { type StageContext, unresolvedTestCheckErrors } from '../validation/run.js';
import type { ConsultRequestInput } from './types.js';

export function criteriaCheckIds(criteria: readonly string[], plan: Plan | undefined): string[] {
  const served = new Set(criteria);
  const checkIds = new Set<string>();
  for (const criterion of plan?.criteria ?? []) {
    if (!served.has(criterion.id)) continue;
    for (const checkId of criterion.checkIds) checkIds.add(checkId);
  }
  return [...checkIds];
}

function verifySelectionErrors(
  task: Task,
  state: WorkflowState,
  answer: ConsultAnswer['answer'],
): string[] {
  if (answer.action !== 'verify') return [];
  const { checkIds } = answer;
  if (checkIds.length === 0) return ['the verify selection names no check'];
  const known = checkRegistry({ task, tasks: state.tasks, plan: state.plan });
  const unknown = checkIds.filter((checkId) => !known.has(checkId));
  if (unknown.length > 0) {
    return [`the verify selection names unknown checks: ${unknown.join(', ')}`];
  }
  // The brief gate checks a criterion only once it is due, so a later owner's check never binds.
  const due = new Set(dueCriterionIds(state, task.id));
  const dueCriteria = (task.criteria ?? []).filter((criterionId) => due.has(criterionId));
  const missing = criteriaCheckIds(dueCriteria, state.plan).filter(
    (checkId) => !checkIds.includes(checkId),
  );
  return missing.length === 0
    ? []
    : [`the verify selection misses the task's criteria checks: ${missing.join(', ')}`];
}

/**
 * The answer contract of one consult. A rewrite or a split never brings in a `cmd` check that the
 * plan command policy refuses or whose npm script no one adds, a `render` check that names no
 * scenario id or that the run cannot render, or a `test` check whose value is not one test file in
 * the workspace or in the files of the answer or of a pending task. A fix task's rewrite or split
 * never targets the user's own files the run left alone. A verify answer names a known check and
 * every check of the task's due criteria (`verifySelectionErrors`), and a stuck review's answer
 * meets `stuckAnswerErrors`. Such an answer fails the schema and the seat gets its one repair.
 */
export function answerContract(
  task: Task,
  reason: ConsultReason,
  stuck: ConsultRequestInput['stuck'],
  checks: {
    known: ReadonlySet<string>;
    /** The run a verify selection is checked against: its checks and its due criteria. */
    state: WorkflowState;
    npmScriptsApproved: boolean;
    projectDir: string;
    renderCommand: string | undefined;
    testChecks: StageContext;
    pendingFiles: readonly string[];
    userFiles: ReadonlySet<string>;
  },
) {
  return {
    jsonSchema: CONSULT_ANSWER_JSON_SCHEMA,
    schemaName: 'consult_answer',
    schema: consultAnswerSchemaFor(task, reason).superRefine((value, ctx) => {
      const specs =
        value.answer.action === 'rewrite-task'
          ? [value.answer.task]
          : value.answer.action === 'split-task'
            ? value.answer.tasks
            : [];
      const specChecks = specs.flatMap((spec) => spec.checks);
      for (const message of [
        ...refusedCheckErrors(specChecks, {
          npmScriptsApproved: checks.npmScriptsApproved,
          projectDir: checks.projectDir,
          writtenFiles: [...checks.pendingFiles, ...specs.flatMap((spec) => spec.suggestedFiles)],
        }).map((error) => error.message),
        ...unconfiguredRenderCheckErrors(specChecks, checks.renderCommand),
        ...unresolvedTestCheckErrors(specs, checks.testChecks, checks.pendingFiles),
        ...fixTaskTargetErrors(specs, checks.userFiles),
        ...(stuck === undefined
          ? verifySelectionErrors(task, checks.state, value.answer)
          : stuckAnswerErrors(value.answer, { ...stuck, knownChecks: checks.known })),
      ]) {
        ctx.addIssue({ code: 'custom', message });
      }
    }),
  };
}
