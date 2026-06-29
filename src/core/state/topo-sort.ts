import type { Task } from '../schemas/task.js';
import { error } from '../../utils/error.js';
import { glyph } from '../../lib/glyphs.js';

export const topoError = {
  circularDependency: (cycle: string[]) =>
    error(
      'topo-circular-dependency',
      `Circular dependency detected: ${cycle.join(` ${glyph('connectorHandoff')} `)}`,
      {
        cycle,
      },
    ),
  unknownDependency: (taskId: string, dependencyId: string) =>
    error('topo-unknown-dependency', `Task ${taskId} depends on unknown task ${dependencyId}`, {
      taskId,
      dependencyId,
    }),
  duplicateTaskId: (taskId: string) =>
    error('topo-duplicate-task-id', `Duplicate task ID: ${taskId}`, { taskId }),
} as const;

export function assertUniqueTaskIds(tasks: Task[]): void {
  const seen = new Set<string>();
  for (const task of tasks) {
    const id = String(task.id);
    if (seen.has(id)) throw topoError.duplicateTaskId(id);
    seen.add(id);
  }
}

export function topoSort(tasks: Task[]): Task[] {
  assertUniqueTaskIds(tasks);
  const taskMap = new Map<string, Task>();
  for (const task of tasks) taskMap.set(task.id, task);

  const visited = new Set<string>();
  const visiting = new Set<string>();
  const sorted: Task[] = [];

  function visit(id: string, path: string[]) {
    if (visited.has(id)) return;
    if (visiting.has(id)) {
      const cycle = [...path.slice(path.indexOf(id)), id];
      throw topoError.circularDependency(cycle);
    }

    const task = taskMap.get(id);
    if (!task) {
      const taskId = path[path.length - 1] ?? id;
      throw topoError.unknownDependency(taskId, id);
    }

    visiting.add(id);
    for (const depId of task.dependsOn) {
      visit(depId, [...path, id]);
    }
    visiting.delete(id);
    visited.add(id);
    sorted.push(task);
  }

  for (const task of tasks) {
    visit(task.id, []);
  }

  return sorted;
}
