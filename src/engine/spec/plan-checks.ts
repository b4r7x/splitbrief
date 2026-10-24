import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { TaskContextFit } from '../../core/schemas/enums.js';
import type { PlanProposal, TaskSpec } from '../../core/schemas/plan.js';
import { REVIEW_CHECK_ID } from '../../core/schemas/review.js';
import { topoSort } from '../../core/state/topo-sort.js';
import { isPathConfined } from '../../lib/path-confinement.js';
import { isENOENT } from '../../lib/process/errors.js';
import { matches } from '../../utils/error.js';
import { parseShellCommand } from '../../utils/parse-shell-command.js';
import { countNoun, pluralize } from '../../utils/pluralize.js';
import { protectedWriteClass } from '../orchestrator/approval/action-classifier.js';
import {
  commandTextRefusal,
  missingNpmScript,
  readPackageScripts,
} from '../orchestrator/planning/sanitize-discovered-validation.js';

export type PlanCheckCode =
  | 'empty-plan'
  | 'duplicate-task-id'
  | 'duplicate-check-id'
  | 'reserved-check-id'
  | 'duplicate-criterion-id'
  | 'criterion-without-check'
  | 'unknown-check'
  | 'uncovered-criterion'
  | 'unknown-criterion'
  | 'task-without-check'
  | 'task-without-criterion'
  | 'task-without-intent'
  | 'path-outside-project'
  | 'path-not-file'
  | 'missing-context-file'
  | 'unprotected-operation'
  | 'unlisted-protected-operation'
  | 'protected-path-not-file'
  | 'unknown-dependency'
  | 'dependency-later-batch'
  | 'dependency-later-task'
  | 'batch-out-of-order'
  | 'dependency-cycle'
  | 'context-overflow'
  | 'no-capable-worker'
  | 'render-check-unconfigured'
  | 'refused-check-command';

/** BUILD's fit for one task, and the routing reason when no implementer can take it. */
export type PlanTaskFit = Readonly<{ fit: TaskContextFit; blocked?: string | undefined }>;

export type PlanCheckError = Readonly<{ code: PlanCheckCode; message: string }>;

export function planRepairWarning(errors: readonly PlanCheckError[]): {
  message: string;
  planCheck?: PlanCheckError;
} {
  const first = errors.find(blocksPlan) ?? errors[0];
  return {
    message: [
      `The plan failed ${countNoun(errors.length, 'check')}. It goes back to the planner once to fix ${errors.length === 1 ? 'it' : 'them'}:`,
      ...errors.map((error) => `- ${error.message}`),
    ].join('\n'),
    ...(first !== undefined && { planCheck: first }),
  };
}

const isCycle = matches('topo-circular-dependency');

function duplicates(ids: readonly string[]): string[] {
  return [...new Set(ids.filter((id, index) => ids.indexOf(id) !== index))];
}

export function pathsOutsideProject(task: TaskSpec, projectDir: string): string[] {
  return [
    ...task.suggestedFiles,
    ...task.contextFiles,
    ...(task.protectedOperations ?? []).map((op) => op.path),
  ].filter((file) => !isPathConfined(file, projectDir));
}

function fileKind(file: string, projectDir: string): 'file' | 'absent' | 'other' {
  try {
    return lstatSync(resolve(projectDir, file)).isFile() ? 'file' : 'other';
  } catch (err) {
    return isENOENT(err) ? 'absent' : 'other';
  }
}

/**
 * A protected operation the write gate can match: one existing or new file, spelled as the
 * checkout spells it. A glob, a directory or another case never equals the changed file the gate
 * asks about.
 */
function isExactFilePath(file: string, projectDir: string): boolean {
  if (/[*?[\]{}]/.test(file) || file.endsWith('/')) return false;
  const kind = fileKind(file, projectDir);
  if (kind === 'absent') return true;
  return (
    kind === 'file' &&
    realpathSync.native(resolve(projectDir, file)) === join(realpathSync.native(projectDir), file)
  );
}

/** What the context files of a task add to its prompt, for a task over BUILD's context. */
function contextFilesText(task: TaskSpec, projectDir: string): string {
  const sizes = task.contextFiles
    .filter((file) => isPathConfined(file, projectDir) && fileKind(file, projectDir) === 'file')
    .map((file) => {
      const chars = readFileSync(resolve(projectDir, file), 'utf-8').length;
      return `${file} (${chars.toLocaleString('en-US')} ${pluralize(chars, 'character')})`;
    });
  return sizes.length === 0
    ? '; split it.'
    : `. Its context files go in with it: ${sizes.join(', ')}. Narrow or drop contextFiles, or split the task.`;
}

/** The suggested and context files inside the project that exist but are not regular files. */
export function pathsNotFiles(task: TaskSpec, projectDir: string): string[] {
  return [...task.suggestedFiles, ...task.contextFiles].filter(
    (file) => isPathConfined(file, projectDir) && fileKind(file, projectDir) === 'other',
  );
}

export function checkTaskIdentities(
  tasks: readonly Pick<TaskSpec, 'id' | 'batch' | 'dependsOn'>[],
  preceding: readonly Pick<TaskSpec, 'id' | 'batch' | 'dependsOn'>[] = [],
): PlanCheckError[] {
  const errors: PlanCheckError[] = [];
  const fail = (code: PlanCheckCode, message: string) => errors.push({ code, message });
  const duplicateTaskIds = duplicates(tasks.map((task) => task.id));
  for (const id of duplicateTaskIds) fail('duplicate-task-id', `Task id ${id} is used twice.`);
  const proposed = new Set(tasks.map((task) => task.id));
  const earlier = preceding.filter((task) => !proposed.has(task.id));
  const batchOf = new Map([...earlier, ...tasks].map((task) => [task.id, task.batch]));
  let unknownDependency = false;
  for (const [index, task] of tasks.entries()) {
    const previous = tasks[index - 1];
    if (previous !== undefined && previous.batch > task.batch) {
      fail(
        'batch-out-of-order',
        `Task ${task.id} (batch ${task.batch}) comes after ${previous.id} (batch ${previous.batch}); list the tasks in batch order.`,
      );
    }
    for (const id of task.dependsOn) {
      const batch = batchOf.get(id);
      if (batch === undefined) {
        unknownDependency = true;
        fail('unknown-dependency', `Task ${task.id} depends on unknown task ${id}.`);
      } else if (batch > task.batch) {
        fail(
          'dependency-later-batch',
          `Task ${task.id} (batch ${task.batch}) depends on ${id} in later batch ${batch}.`,
        );
      }
    }
  }
  if (duplicateTaskIds.length === 0 && !unknownDependency) {
    try {
      topoSort([...earlier.map((task) => ({ ...task, dependsOn: [] })), ...tasks]);
      const listed = new Set<string>(earlier.map((task) => task.id));
      for (const task of tasks) {
        for (const id of task.dependsOn.filter((dep) => batchOf.get(dep) === task.batch)) {
          if (!listed.has(id)) {
            fail(
              'dependency-later-task',
              `Task ${task.id} depends on ${id}, which is listed after it; list ${id} first.`,
            );
          }
        }
        listed.add(task.id);
      }
    } catch (err) {
      if (!isCycle(err)) throw err;
      fail('dependency-cycle', err.message);
    }
  }
  return errors;
}

/** The ids of every `render` check in `checks`, in order, or none when the run sets `validation.render`. */
function unconfiguredRenderCheckIds(
  checks: readonly Pick<TaskSpec['checks'][number], 'id' | 'kind'>[],
  renderCommand: string | undefined,
): string[] {
  if (renderCommand !== undefined) return [];
  return checks.filter((check) => check.kind === 'render').map((check) => check.id);
}

/** "Render checks A, B need validation.render, which is not set", in the number the ids have. */
function renderChecksNeedCommand(ids: readonly string[]): string {
  return `${pluralize(ids.length, 'Render check')} ${ids.join(', ')} ${pluralize(ids.length, 'needs', 'need')} validation.render, which is not set`;
}

/** The plan card's note for every render check without a command; none when the command is set. */
export function renderCheckNotes(plan: PlanProposal, renderCommand: string | undefined): string[] {
  const ids = unconfiguredRenderCheckIds(
    [...plan.checks, ...plan.tasks.flatMap((task) => task.checks)],
    renderCommand,
  );
  return ids.length === 0
    ? []
    : [
        `${renderChecksNeedCommand(ids)}. Add it to .splitbrief/config.yaml, or request changes to drop ${pluralize(ids.length, 'it', 'them')}; without it the run halts before its review.`,
      ];
}

/**
 * The render checks of the tasks a review or a consult writes, refused while the run sets no
 * `validation.render`: no user is asked about them, so they go back to the seat that wrote them.
 */
export function unconfiguredRenderCheckErrors(
  checks: readonly Pick<TaskSpec['checks'][number], 'id' | 'kind'>[],
  renderCommand: string | undefined,
): string[] {
  const ids = unconfiguredRenderCheckIds(checks, renderCommand);
  return ids.length === 0 ? [] : [`${renderChecksNeedCommand(ids)}; use a check of another kind.`];
}

/**
 * An unconfigured render check is the user's to settle, so after the planner's one repair it stands
 * on the plan card instead of halting the run.
 */
export function blocksPlan(error: PlanCheckError): boolean {
  return error.code !== 'render-check-unconfigured';
}

/** The shape of a render check's value: one gallery scenario id. */
export const RENDER_ID_PATTERN = /^[a-z0-9-]+$/;

/**
 * The checks refused before they run: a plan's checks, the checks of the fix tasks a review writes,
 * and the checks of a consult's rewrite or split. A refused command, an npm script that
 * package.json lacks while no task writes package.json, a `test` check that holds more than one
 * path, or a `render` check that names no scenario id never becomes a required check.
 */
export function refusedCheckErrors(
  checks: readonly Pick<TaskSpec['checks'][number], 'id' | 'kind' | 'value'>[],
  policy: { npmScriptsApproved: boolean; projectDir: string; writtenFiles: readonly string[] },
): PlanCheckError[] {
  const packageScripts = policy.writtenFiles.includes('package.json')
    ? null
    : readPackageScripts(policy.projectDir);
  return checks.flatMap((check): PlanCheckError[] => {
    if (check.kind === 'test') {
      return parseShellCommand(check.value).length === 1
        ? []
        : [
            {
              code: 'refused-check-command',
              message: `Check ${check.id} is refused: a \`test\` check names one test file, and \`${check.value}\` is not one file. Make it a \`cmd\` check that runs this command, or set its value to the test file.`,
            },
          ];
    }
    if (check.kind === 'render') {
      return RENDER_ID_PATTERN.test(check.value)
        ? []
        : [
            {
              code: 'refused-check-command',
              message: `Check ${check.id} is refused: a \`render\` check names one scenario id of lowercase letters, digits and hyphens, and \`${check.value}\` is not one.`,
            },
          ];
    }
    const refusal = commandTextRefusal(check.value, policy.npmScriptsApproved);
    if (refusal !== null) {
      return [
        {
          code: 'refused-check-command',
          message: `Check ${check.id} is refused: \`${check.value}\` ${refusal}. Change it to a command that plan checks allow, or to a check of kind \`test\` that names a test file.`,
        },
      ];
    }
    const missing =
      packageScripts === null
        ? null
        : missingNpmScript(check.value, policy.npmScriptsApproved, packageScripts);
    return missing === null
      ? []
      : [
          {
            code: 'refused-check-command',
            message: `Check ${check.id} is refused: \`${check.value}\` ${missing}. Name a script that package.json defines, or list package.json in the task's files and add the script there.`,
          },
        ];
  });
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
    fail('reserved-check-id', `Check id ${id} is reserved for the reviewer's checks (V1, V2, …).`);
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
    if (estimate?.fit === 'overflow') {
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

  const renderCheckIds = unconfiguredRenderCheckIds(checks, renderCommand);
  if (renderCheckIds.length > 0) {
    fail(
      'render-check-unconfigured',
      `${renderChecksNeedCommand(renderCheckIds)}; drop ${pluralize(renderCheckIds.length, 'it', 'them')} or ask the user.`,
    );
  }
  return errors;
}
