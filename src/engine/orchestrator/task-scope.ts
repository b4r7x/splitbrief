import type { Task } from '../../core/schemas/task.js';

export function taskScopePatterns(task: Task): string[] {
  return [...(task.scope?.inBounds ?? []), ...(task.scope?.approvedOutOfBounds ?? [])];
}

export function taskAcceptedPatterns(task: Task): string[] {
  return [task.file, ...taskScopePatterns(task)];
}
