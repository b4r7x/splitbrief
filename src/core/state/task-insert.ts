import { formatTaskId, type Task, type TaskId } from '../schemas/task.js';
import type { TaskSpec } from '../schemas/plan.js';

export function lineageIdOf(task: Pick<Task, 'id' | 'parentId'>): TaskId {
  return task.parentId ?? task.id;
}

/** The next free ids: the numbers after the highest existing id, in order. */
export function nextTaskIds(tasks: readonly Task[], count: number): TaskId[] {
  let highest = 0;
  for (const task of tasks) {
    const numeric = Number(task.id.slice(1));
    if (numeric > highest) highest = numeric;
  }
  return Array.from({ length: count }, (_, index) => formatTaskId(highest + index + 1));
}

export function insertTasks<Spec extends TaskSpec>(
  specs: readonly Spec[],
  tasks: readonly Task[],
  convert: (spec: Spec) => Task,
): Task[] {
  const ids = nextTaskIds(tasks, specs.length);
  const assigned = new Map<string, TaskId>();
  specs.forEach((spec, index) => {
    const id = ids[index];
    if (id !== undefined) assigned.set(spec.id, id);
  });
  return specs.map((spec) => {
    const converted = convert(spec);
    return {
      ...converted,
      id: assigned.get(spec.id) ?? converted.id,
      dependsOn: spec.dependsOn.map((dependency) => assigned.get(dependency) ?? dependency),
    };
  });
}
