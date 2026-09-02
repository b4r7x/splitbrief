import type { Task } from '../../../core/schemas/task.js';
import { taskMergeError } from './merge.js';

/**
 * The global Task invariants a merged set must hold regardless of how it was
 * produced: unique ids, one operation per file, resolvable dependencies, and
 * an acyclic dependency graph.
 */
export function assertGlobalTaskInvariants(tasks: readonly Task[]): void {
  const ids = new Set<string>();
  const files = new Set<string>();
  for (const task of tasks) {
    const id = String(task.id);
    if (ids.has(id)) throw taskMergeError.duplicateId(id);
    ids.add(id);
    if (files.has(task.file)) throw taskMergeError.duplicateOperation(task.file);
    files.add(task.file);
  }
  for (const task of tasks) {
    for (const dependency of task.dependsOn) {
      if (!ids.has(String(dependency))) {
        throw taskMergeError.unknownDependency(String(task.id), String(dependency));
      }
    }
  }
  assertNoDependencyCycle(tasks, ids);
}

function assertNoDependencyCycle(tasks: readonly Task[], ids: ReadonlySet<string>): void {
  const byId = new Map(tasks.map((task) => [String(task.id), task] as const));
  const state = new Map<string, 'visiting' | 'done'>();
  const path: string[] = [];
  const visit = (id: string): void => {
    const current = state.get(id);
    if (current === 'done') return;
    if (current === 'visiting') throw taskMergeError.cycle([...path, id]);
    state.set(id, 'visiting');
    path.push(id);
    const task = byId.get(id);
    for (const dependency of task?.dependsOn ?? []) visit(String(dependency));
    path.pop();
    state.set(id, 'done');
  };
  for (const id of ids) visit(id);
}
