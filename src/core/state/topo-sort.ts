import type { Task } from '../schemas/task.js';
import { error, matches } from '../../utils/error.js';

export const topoError = {
  circularDependency: (cycle: string[]) =>
    error(
      'topo-circular-dependency',
      `Circular dependency detected: ${cycle.join(' → ')}`,
      { cycle },
    ),
  isCircularDependency: matches('topo-circular-dependency'),
} as const;

export function topoSort(tasks: Task[]): Task[] {
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
    if (!task) return;

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
