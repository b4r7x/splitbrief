import type { Check, Task } from '../../core/schemas/task.js';
import type { TaskSpec } from '../../core/schemas/plan.js';
import { confinedExists } from '../../lib/confined-fs.js';
import { isPathConfined } from '../../lib/path-confinement.js';
import { error } from '../../utils/error.js';
import { inputHashesNow, specInputFiles } from '../orchestrator/task/stale-inputs.js';

const planTaskError = {
  noSuggestedFile: (id: string) =>
    error('plan-task-no-suggested-file', `Task ${id} suggests no file`, { id }),
} as const;

export function formatCheck(check: Check): string {
  return `${check.id} ${check.kind}${check.required ? '' : ' (optional)'}: ${check.value}`;
}

/** What a brief does to its anchor: `modify` when the file is in the checkout, else `create`. */
export function anchorAction(file: string, projectDir: string): Task['action'] {
  return isPathConfined(file, projectDir) && confinedExists(projectDir, file) ? 'modify' : 'create';
}

/** A plan task in the legacy brief shape every engine path reads, with the plan fields kept. */
export function taskFromSpec(spec: TaskSpec, projectDir: string): Task {
  const [file] = spec.suggestedFiles;
  if (file === undefined) throw planTaskError.noSuggestedFile(spec.id);
  return {
    id: spec.id,
    title: spec.title,
    status: 'pending',
    action: anchorAction(file, projectDir),
    file,
    files: spec.suggestedFiles,
    dependsOn: spec.dependsOn,
    description: spec.intent,
    tests: spec.checks.filter((check) => check.kind === 'test').map((check) => check.value),
    implementationSteps: spec.steps ?? [],
    scope: { outOfBounds: spec.exclusions },
    constraints: [],
    typeDefs: '',
    evidence: spec.checks.map(formatCheck),
    criteria: spec.criteria,
    checks: spec.checks,
    suggestedFiles: spec.suggestedFiles,
    contextFiles: spec.contextFiles,
    exclusions: spec.exclusions,
    inputHashes: inputHashesNow(projectDir, specInputFiles(spec)),
    ...(spec.protectedOperations !== null && { protectedOperations: spec.protectedOperations }),
    batch: spec.batch,
  };
}
