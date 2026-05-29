import { parseTasks } from '../../../../engine/spec/parser.js';
import type { Task, TaskId } from '../../../../core/schemas/task.js';
import { formatTaskId } from '../../../../core/schemas/task.js';
import { topoSort } from '../../../../core/state/topo-sort.js';
import { toErrorMessage } from '../../../../utils/format-errors.js';

export function renumberTasks(tasks: Task[]): Task[] {
  const idMap = new Map<TaskId, TaskId>();
  for (let i = 0; i < tasks.length; i++) {
    const task = tasks[i];
    if (!task) continue;
    const newId = formatTaskId(i + 1);
    idMap.set(task.id, newId);
  }
  return tasks.map((task) => ({
    ...task,
    id: idMap.get(task.id) ?? task.id,
    dependsOn: task.dependsOn.map((dep) => idMap.get(dep) ?? dep),
  }));
}

export function relinkAfterDelete(
  tasks: Task[],
  deletedId: TaskId,
  deletedDependsOn: TaskId[],
): Task[] {
  return tasks.map((task) => {
    if (!task.dependsOn.includes(deletedId)) return task;
    const inherited = deletedDependsOn.filter((dep) => dep !== deletedId);
    const without = task.dependsOn.filter((dep) => dep !== deletedId);
    const merged = Array.from(new Set([...without, ...inherited]));
    return { ...task, dependsOn: merged };
  });
}

export function deleteTask(tasks: Task[], cursor: number): { tasks: Task[]; cursor: number } {
  if (tasks.length === 0 || cursor < 0 || cursor >= tasks.length) {
    return { tasks, cursor };
  }
  const deletedTask = tasks[cursor];
  if (!deletedTask) return { tasks, cursor };
  const remaining = tasks.filter((_, i) => i !== cursor);
  const relinked = relinkAfterDelete(remaining, deletedTask.id, deletedTask.dependsOn);
  const result = renumberTasks(topoSort(relinked));
  const clampedCursor = result.length === 0 ? 0 : Math.min(cursor, result.length - 1);
  return { tasks: result, cursor: clampedCursor };
}

function mergeScope(prev: Task['scope'], curr: Task['scope']): Task['scope'] {
  if (!prev && !curr) return undefined;
  const inBounds = [...(prev?.inBounds ?? []), ...(curr?.inBounds ?? [])];
  const outOfBounds = [...(prev?.outOfBounds ?? []), ...(curr?.outOfBounds ?? [])];
  const result: NonNullable<Task['scope']> = {};
  if (inBounds.length > 0) result.inBounds = inBounds;
  if (outOfBounds.length > 0) result.outOfBounds = outOfBounds;
  return result;
}

function mergeOptionalArray(
  prev: string[] | undefined,
  curr: string[] | undefined,
): string[] | undefined {
  if (!prev && !curr) return undefined;
  return [...(prev ?? []), ...(curr ?? [])];
}

export function mergeWithPrevious(
  tasks: Task[],
  cursor: number,
): { tasks: Task[]; cursor: number; error?: string } {
  if (cursor === 0) {
    return { tasks, cursor, error: 'cannot merge first task' };
  }
  const prev = tasks[cursor - 1];
  const curr = tasks[cursor];
  if (!prev || !curr) return { tasks, cursor };

  const dependsOn = Array.from(new Set([...prev.dependsOn, ...curr.dependsOn])).filter(
    (dep) => dep !== curr.id && dep !== prev.id,
  );

  const merged: Task = {
    id: prev.id,
    title: `${prev.title} + ${curr.title}`,
    file: prev.file,
    action: prev.action === 'modify' || curr.action === 'modify' ? 'modify' : 'create',
    description: `${prev.description}\n\n---\n\n${curr.description}`,
    tests: [...prev.tests, ...curr.tests],
    implementationSteps: [...prev.implementationSteps, ...curr.implementationSteps],
    constraints: [...prev.constraints, ...curr.constraints],
    dependsOn,
    typeDefs: prev.typeDefs
      ? curr.typeDefs
        ? `${prev.typeDefs}\n\n${curr.typeDefs}`
        : prev.typeDefs
      : curr.typeDefs,
    signature: prev.signature ?? curr.signature,
    currentCode: prev.currentCode ?? curr.currentCode,
    pattern: prev.pattern ?? curr.pattern,
    scope: mergeScope(prev.scope, curr.scope),
    escalation: mergeOptionalArray(prev.escalation, curr.escalation),
    evidence: mergeOptionalArray(prev.evidence, curr.evidence),
    status: 'pending',
  };

  const updated = [...tasks.slice(0, cursor - 1), merged, ...tasks.slice(cursor + 1)];
  const relinked = relinkAfterDelete(updated, curr.id, [prev.id]);
  const result = renumberTasks(topoSort(relinked));
  return { tasks: result, cursor: cursor - 1 };
}

export function moveTaskDown(tasks: Task[], cursor: number): { tasks: Task[]; cursor: number } {
  if (cursor < 0 || cursor >= tasks.length - 1) {
    return { tasks, cursor };
  }
  const result = [...tasks];
  const a = result[cursor];
  const b = result[cursor + 1];
  if (!a || !b) return { tasks, cursor };
  result[cursor] = b;
  result[cursor + 1] = a;
  return { tasks: renumberTasks(result), cursor: cursor + 1 };
}

export function moveTaskUp(tasks: Task[], cursor: number): { tasks: Task[]; cursor: number } {
  if (cursor <= 0 || cursor >= tasks.length) {
    return { tasks, cursor };
  }
  const result = [...tasks];
  const a = result[cursor];
  const b = result[cursor - 1];
  if (!a || !b) return { tasks, cursor };
  result[cursor] = b;
  result[cursor - 1] = a;
  return { tasks: renumberTasks(result), cursor: cursor - 1 };
}

export function parseSplitResult(markdown: string): Task[] | { error: string } {
  let parsed: Task[];
  try {
    parsed = parseTasks(markdown);
  } catch (err) {
    return { error: `split parse failed: ${toErrorMessage(err)}` };
  }
  if (parsed.length === 0) {
    return { error: 'split produced no tasks' };
  }
  return parsed.map((task) => ({ ...task, status: 'pending' as const }));
}
