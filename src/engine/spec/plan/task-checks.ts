import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { TaskSpec } from '../../../core/schemas/plan.js';
import { topoSort } from '../../../core/state/topo-sort.js';
import { isPathConfined } from '../../../lib/fs/confinement.js';
import { isENOENT } from '../../../utils/errno.js';
import { matches } from '../../../utils/error.js';
import { pluralize } from '../../../utils/pluralize.js';
import type { PlanCheckError, PlanCheckCode } from './types.js';

const isCycle = matches('topo-circular-dependency');

export function duplicates(ids: readonly string[]): string[] {
  return [...new Set(ids.filter((id, index) => ids.indexOf(id) !== index))];
}

export function pathsOutsideProject(task: TaskSpec, projectDir: string): string[] {
  return [
    ...task.suggestedFiles,
    ...task.contextFiles,
    ...(task.protectedOperations ?? []).map((op) => op.path),
  ].filter((file) => !isPathConfined(file, projectDir));
}

export function fileKind(file: string, projectDir: string): 'file' | 'absent' | 'other' {
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
export function isExactFilePath(file: string, projectDir: string): boolean {
  if (/[*?[\]{}]/.test(file) || file.endsWith('/')) return false;
  const kind = fileKind(file, projectDir);
  if (kind === 'absent') return true;
  return (
    kind === 'file' &&
    realpathSync.native(resolve(projectDir, file)) === join(realpathSync.native(projectDir), file)
  );
}

/** What the context files of a task add to its prompt, for a task over BUILD's context. */
export function contextFilesText(task: TaskSpec, projectDir: string): string {
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
