import { TaskSchema, type Task } from '../../../core/schemas/task.js';
import { canonicalJSON } from '../../../utils/canonical-json.js';
import { error, matches } from '../../../utils/error.js';
import { sha256Hex } from '../../../utils/sha256.js';
import { TaskManifestSchema, type TaskManifest } from './manifest.js';

export type TaskMergeResult = Readonly<{
  tasks: readonly Task[];
  tasksDigest: string;
}>;

export const taskMergeError = {
  invalidManifest: (detail: string) =>
    error('task_compiler_manifest_invalid', `Cannot merge against an invalid manifest: ${detail}`, {
      detail,
    }),
  mismatch: (detail: string) =>
    error('task_compiler_manifest_mismatch', `Task manifest mismatch: ${detail}`, { detail }),
  duplicateId: (id: string) =>
    error('task_compiler_duplicate_id', `Duplicate Task ID: ${id}`, { id }),
  duplicateOperation: (file: string) =>
    error('task_compiler_duplicate_operation', `Duplicate file operation: ${file}`, { file }),
  invalidTask: (detail: string) =>
    error('task_compiler_invalid_markdown', `Invalid admitted Task Brief: ${detail}`, { detail }),
  unknownDependency: (taskId: string, dependencyId: string) =>
    error(
      'task_compiler_unknown_dependency',
      `Task ${taskId} depends on unknown Task ${dependencyId}.`,
      { taskId, dependencyId },
    ),
  forwardDependency: (taskId: string, dependencyId: string) =>
    error(
      'task_compiler_forward_dependency',
      `Task ${taskId} depends on later Task ${dependencyId}.`,
      { taskId, dependencyId },
    ),
  cycle: (taskIds: readonly string[]) =>
    error('task_compiler_cycle', `Task dependency cycle: ${taskIds.join(' -> ')}`, { taskIds }),
  isMismatch: matches('task_compiler_manifest_mismatch'),
  isDuplicateId: matches('task_compiler_duplicate_id'),
  isDuplicateOperation: matches('task_compiler_duplicate_operation'),
  isUnknownDependency: matches('task_compiler_unknown_dependency'),
  isForwardDependency: matches('task_compiler_forward_dependency'),
  isCycle: matches('task_compiler_cycle'),
} as const;

export function mergeTaskResult(manifest: TaskManifest, blocks: readonly Task[]): TaskMergeResult {
  validateManifest(manifest);

  const tasks = parseTasks(blocks);
  const manifestById = new Map(manifest.items.map((item) => [String(item.id), item]));
  const seenIds = new Set<string>();
  const seenFiles = new Set<string>();
  const taskById = new Map<string, Task>();

  for (const task of tasks) {
    const id = String(task.id);
    if (seenIds.has(id)) throw taskMergeError.duplicateId(id);
    seenIds.add(id);

    if (seenFiles.has(task.file)) throw taskMergeError.duplicateOperation(task.file);
    seenFiles.add(task.file);
    const expected = manifestById.get(id);
    if (expected === undefined) throw taskMergeError.mismatch(`unexpected Task ID ${id}`);
    if (task.file !== expected.file || task.action !== expected.action) {
      throw taskMergeError.mismatch(
        `${id} must target ${expected.action} ${expected.file}, received ${task.action} ${task.file}`,
      );
    }
    taskById.set(id, task);
  }

  if (tasks.length !== manifest.items.length) {
    const missing = manifest.items
      .filter((item) => !seenIds.has(String(item.id)))
      .map((item) => String(item.id));
    throw taskMergeError.mismatch(`missing manifest items: ${missing.join(', ')}`);
  }

  const ordered = stableTopologicalOrder(tasks, manifest, taskById, manifestById);
  const frozenTasks = Object.freeze(ordered.map((task) => Object.freeze(task)));
  return Object.freeze({
    tasks: frozenTasks,
    tasksDigest: digestTasks(manifest.manifestDigest, frozenTasks),
  });
}

export function digestTasks(manifestDigest: string, tasks: readonly Task[]): string {
  return `tasks-${sha256Hex(
    `task-brief-merged-tasks\u0000${canonicalJSON({ manifestDigest, tasks })}`,
  )}`;
}

function validateManifest(manifest: TaskManifest): void {
  const parsed = TaskManifestSchema.safeParse(manifest);
  if (!parsed.success) throw taskMergeError.invalidManifest(parsed.error.message);
  const ids = new Set<string>();
  const files = new Set<string>();
  for (const item of manifest.items) {
    const id = String(item.id);
    if (ids.has(id)) throw taskMergeError.invalidManifest(`duplicate manifest ID ${id}`);
    if (files.has(item.file))
      throw taskMergeError.invalidManifest(`duplicate manifest file ${item.file}`);
    ids.add(id);
    files.add(item.file);
  }
}

function parseTasks(blocks: readonly Task[]): Task[] {
  return blocks.map((block, index) => {
    const parsed = TaskSchema.safeParse(block);
    if (!parsed.success) {
      throw taskMergeError.invalidTask(`block ${index + 1}: ${parsed.error.message}`);
    }
    return parsed.data;
  });
}

function stableTopologicalOrder(
  tasks: readonly Task[],
  manifest: TaskManifest,
  taskById: ReadonlyMap<string, Task>,
  manifestById: ReadonlyMap<string, TaskManifest['items'][number]>,
): Task[] {
  const indegree = new Map<string, number>();
  const dependents = new Map<string, string[]>();
  const forwardDependencies: Array<readonly [string, string]> = [];
  for (const task of tasks) {
    const taskId = String(task.id);
    indegree.set(taskId, 0);
    dependents.set(taskId, []);
  }

  for (const task of tasks) {
    const taskId = String(task.id);
    const taskOrdinal = manifestById.get(taskId)?.ordinal;
    if (taskOrdinal === undefined) throw taskMergeError.mismatch(`unexpected Task ID ${taskId}`);
    const dependencies = new Set<string>();
    for (const dependency of task.dependsOn) {
      const dependencyId = String(dependency);
      if (!taskById.has(dependencyId)) throw taskMergeError.unknownDependency(taskId, dependencyId);
      const dependencyOrdinal = manifestById.get(dependencyId)?.ordinal;
      if (dependencyOrdinal === undefined) {
        throw taskMergeError.unknownDependency(taskId, dependencyId);
      }
      if (dependencyOrdinal > taskOrdinal) {
        forwardDependencies.push([taskId, dependencyId]);
      }
      if (dependencies.has(dependencyId)) continue;
      dependencies.add(dependencyId);
      indegree.set(taskId, (indegree.get(taskId) ?? 0) + 1);
      dependents.get(dependencyId)?.push(taskId);
    }
  }

  const ready = tasks
    .filter((task) => indegree.get(String(task.id)) === 0)
    .sort((left, right) => manifestOrdinal(left, manifest) - manifestOrdinal(right, manifest));
  const ordered: Task[] = [];
  while (ready.length > 0) {
    const task = ready.shift();
    if (task === undefined) break;
    const taskId = String(task.id);
    ordered.push(task);
    for (const dependentId of dependents.get(taskId) ?? []) {
      const nextDegree = (indegree.get(dependentId) ?? 0) - 1;
      indegree.set(dependentId, nextDegree);
      if (nextDegree === 0) {
        const dependent = taskById.get(dependentId);
        if (dependent !== undefined) insertReady(ready, dependent, manifest);
      }
    }
  }

  if (ordered.length !== tasks.length) {
    const remaining = tasks
      .filter((task) => !ordered.some((candidate) => candidate.id === task.id))
      .map((task) => String(task.id));
    throw taskMergeError.cycle(remaining);
  }
  const forwardDependency = forwardDependencies[0];
  if (forwardDependency !== undefined) {
    throw taskMergeError.forwardDependency(forwardDependency[0], forwardDependency[1]);
  }
  return ordered;
}

function insertReady(ready: Task[], task: Task, manifest: TaskManifest): void {
  const ordinal = manifestOrdinal(task, manifest);
  const index = ready.findIndex((candidate) => manifestOrdinal(candidate, manifest) > ordinal);
  if (index === -1) ready.push(task);
  else ready.splice(index, 0, task);
}

function manifestOrdinal(task: Task, manifest: TaskManifest): number {
  const item = manifest.items.find((candidate) => candidate.id === task.id);
  if (item === undefined) throw taskMergeError.mismatch(`unexpected Task ID ${task.id}`);
  return item.ordinal;
}
