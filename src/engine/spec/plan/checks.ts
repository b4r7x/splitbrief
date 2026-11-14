import type { PlanProposal } from '../../../core/schemas/plan.js';
import { REVIEW_CHECK_ID } from '../../../core/schemas/review/verdict.js';
import { isPathConfined } from '../../../lib/fs/confinement.js';
import { countNoun, pluralize } from '../../../utils/pluralize.js';
import { protectedWriteClass } from '../../orchestrator/approval/action-classifier.js';
import { reviewerCommandRefusal } from '../../orchestrator/validation/reviewer-command-policy.js';
import {
  refusedCheckErrors,
  unconfiguredRenderCheckIds,
  renderChecksNeedCommand,
} from './render-checks.js';
import {
  checkTaskIdentities,
  duplicates,
  pathsOutsideProject,
  pathsNotFiles,
  fileKind,
  isExactFilePath,
  contextFilesText,
} from './task-checks.js';
import type { PlanCheckError, PlanTaskFit, PlanCheckCode } from './types.js';

export function planRepairWarning(errors: readonly PlanCheckError[]): { message: string } {
  return {
    message: [
      `The plan failed ${countNoun(errors.length, 'check')}. It goes back to the planner once to fix ${errors.length === 1 ? 'it' : 'them'}:`,
      ...errors.map((error) => `- ${error.message}`),
    ].join('\n'),
  };
}

/**
 * An unconfigured render check is the user's to settle, so after the planner's one repair it stands
 * on the plan card instead of halting the run.
 */
export function blocksPlan(error: PlanCheckError): boolean {
  return error.code !== 'render-check-unconfigured';
}

/**
 * The deterministic checks a plan passes before anyone approves it. `taskFits` is BUILD's fit per
 * task id, estimated with the task's fresh code: `overflow` blocks, and so does a task that no
 * implementer can take. `npmScriptsApproved` is the run's plan approval, under which a `cmd` check
 * may run an npm script.
 */
export function checkPlan(
  plan: PlanProposal,
  projectDir: string,
  taskFits: ReadonlyMap<string, PlanTaskFit>,
  renderCommand: string | undefined,
  npmScriptsApproved: boolean,
): PlanCheckError[] {
  const errors: PlanCheckError[] = [];
  const fail = (code: PlanCheckCode, message: string) => errors.push({ code, message });

  if (plan.tasks.length === 0) fail('empty-plan', 'The plan has no task.');
  if (plan.criteria.length === 0) fail('empty-plan', 'The plan has no criterion.');

  const checks = [...plan.checks, ...plan.tasks.flatMap((task) => task.checks)];
  const checkIds = checks.map((check) => check.id);
  errors.push(...checkTaskIdentities(plan.tasks));
  for (const id of duplicates(checkIds))
    fail('duplicate-check-id', `Check id ${id} is used twice.`);
  for (const id of new Set(checkIds.filter((checkId) => REVIEW_CHECK_ID.test(checkId)))) {
    fail('reserved-check-id', `Check id ${id} is reserved for the project gate (V1, V2, …).`);
  }
  for (const [index, command] of plan.gate.entries()) {
    const refusal = reviewerCommandRefusal(command);
    if (refusal === null) continue;
    fail(
      'refused-check-command',
      `Gate command V${index + 1} is refused: \`${command}\` ${refusal}. Name a command the project's scripts or CI run, as one program and its arguments.`,
    );
  }
  for (const id of duplicates(plan.criteria.map((criterion) => criterion.id)))
    fail('duplicate-criterion-id', `Criterion id ${id} is used twice.`);
  errors.push(
    ...refusedCheckErrors(checks, {
      npmScriptsApproved,
      projectDir,
      writtenFiles: plan.tasks.flatMap((task) => task.suggestedFiles),
    }),
  );

  for (const criterion of plan.criteria) {
    if (criterion.checkIds.length === 0) {
      fail('criterion-without-check', `Criterion ${criterion.id} names no check that verifies it.`);
    }
    for (const id of criterion.checkIds.filter((checkId) => !checkIds.includes(checkId))) {
      fail('unknown-check', `Criterion ${criterion.id} names unknown check ${id}.`);
    }
    if (!plan.tasks.some((task) => task.criteria.includes(criterion.id))) {
      fail('uncovered-criterion', `Criterion ${criterion.id} is served by no task.`);
    }
  }

  const criterionIds = plan.criteria.map((criterion) => criterion.id);
  const written = new Set<string>();
  for (const task of plan.tasks) {
    if (task.criteria.length === 0)
      fail('task-without-criterion', `Task ${task.id} serves no criterion.`);
    if (task.intent.trim() === '') fail('task-without-intent', `Task ${task.id} has no intent.`);
    for (const id of task.criteria.filter((criterion) => !criterionIds.includes(criterion))) {
      fail('unknown-criterion', `Task ${task.id} serves unknown criterion ${id}.`);
    }
    if (task.checks.length === 0) fail('task-without-check', `Task ${task.id} has no check.`);
    for (const file of pathsOutsideProject(task, projectDir)) {
      fail('path-outside-project', `Task ${task.id} names ${file}, outside the project.`);
    }
    for (const file of pathsNotFiles(task, projectDir)) {
      fail('path-not-file', `Task ${task.id} names ${file}, which is not a regular file.`);
    }
    for (const file of task.suggestedFiles) written.add(file);
    for (const file of task.contextFiles) {
      if (
        isPathConfined(file, projectDir) &&
        !written.has(file) &&
        fileKind(file, projectDir) === 'absent'
      ) {
        fail(
          'missing-context-file',
          `Task ${task.id} reads ${file}, which does not exist and neither this task nor an earlier one writes.`,
        );
      }
    }
    for (const { path } of task.protectedOperations ?? []) {
      if (!isPathConfined(path, projectDir)) continue;
      if (!isExactFilePath(path, projectDir)) {
        fail(
          'protected-path-not-file',
          `Task ${task.id} lists write ${path} as a protected operation, but that is not one file the task writes; list the exact path of each file, as the checkout spells it.`,
        );
      } else if (protectedWriteClass(path, projectDir) === null) {
        fail(
          'unprotected-operation',
          `Task ${task.id} lists write ${path} as a protected operation, but writing it asks for nothing; drop it from protectedOperations.`,
        );
      }
    }
    const listedPaths = (task.protectedOperations ?? []).map((op) => op.path);
    for (const file of task.suggestedFiles) {
      if (
        isPathConfined(file, projectDir) &&
        !listedPaths.includes(file) &&
        protectedWriteClass(file, projectDir) !== null
      ) {
        fail(
          'unlisted-protected-operation',
          `Task ${task.id} writes ${file}, a protected path, without listing it in protectedOperations; list { path: "${file}", operation: "write" }.`,
        );
      }
    }
  }

  for (const task of plan.tasks) {
    const estimate = taskFits.get(task.id);
    if (estimate?.blocked !== undefined && estimate.fit === 'overflow') {
      fail(
        'context-overflow',
        `Task ${task.id} does not fit the BUILD model’s context${contextFilesText(task, projectDir)}`,
      );
    } else if (estimate?.blocked !== undefined) {
      fail(
        'no-capable-worker',
        `Task ${task.id} has no implementer that can take it: ${estimate.blocked}.`,
      );
    }
  }

  const unconfigured = unconfiguredRenderCheckIds(checks, renderCommand);
  if (unconfigured.length > 0) {
    fail(
      'render-check-unconfigured',
      `${renderChecksNeedCommand(unconfigured)}; drop ${pluralize(unconfigured.length, 'it', 'them')} or ask the user.`,
    );
  }
  return errors;
}
