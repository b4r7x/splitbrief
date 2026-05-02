import type { Task, TaskId } from '../../../core/schemas/task.js';

export function resolveDependsOnFiles(tasks: Task[], task: Task): string[] {
  return task.dependsOn.flatMap((id: TaskId) => {
    const dep = tasks.find((t) => t.id === id);
    return dep ? [dep.file] : [];
  });
}
