import type { Task } from '../../core/schemas/task.js';

export const TASK_BRIEF_SECTIONS = [
  'title',
  'description',
  'implementationSteps',
  'constraints',
  'tests',
  'escalation',
  'scope.inBounds',
  'scope.outOfBounds',
  'scope.approvedOutOfBounds',
] as const;

export type TaskBriefSection = (typeof TASK_BRIEF_SECTIONS)[number];

export function getTaskBriefSectionLabel(section: TaskBriefSection): string {
  switch (section) {
    case 'title':
      return 'Title';
    case 'description':
      return 'Description';
    case 'implementationSteps':
      return 'Implementation steps';
    case 'constraints':
      return 'Constraints';
    case 'tests':
      return 'Tests';
    case 'escalation':
      return 'Escalation';
    case 'scope.inBounds':
      return 'Scope: in bounds';
    case 'scope.outOfBounds':
      return 'Scope: out of bounds';
    case 'scope.approvedOutOfBounds':
      return 'Scope: approved out of bounds';
  }
}

export function getTaskBriefSectionText(task: Task, section: TaskBriefSection): string {
  switch (section) {
    case 'title':
      return task.title;
    case 'description':
      return task.description;
    case 'implementationSteps':
      return task.implementationSteps.join('\n');
    case 'constraints':
      return task.constraints.join('\n');
    case 'tests':
      return task.tests.join('\n');
    case 'escalation':
      return (task.escalation ?? []).join('\n');
    case 'scope.inBounds':
      return (task.scope?.inBounds ?? []).join('\n');
    case 'scope.outOfBounds':
      return (task.scope?.outOfBounds ?? []).join('\n');
    case 'scope.approvedOutOfBounds':
      return (task.scope?.approvedOutOfBounds ?? []).join('\n');
  }
}

export function updateTaskBriefSection(task: Task, section: TaskBriefSection, value: string): Task {
  switch (section) {
    case 'title':
      return { ...task, title: value.trim() };
    case 'description':
      return { ...task, description: value.trim() };
    case 'implementationSteps':
      return { ...task, implementationSteps: parseListValue(value) };
    case 'constraints':
      return { ...task, constraints: parseListValue(value) };
    case 'tests':
      return { ...task, tests: parseListValue(value) };
    case 'escalation': {
      const escalation = parseListValue(value);
      return escalation.length === 0
        ? stripOptionalArray(task, 'escalation')
        : { ...task, escalation };
    }
    case 'scope.inBounds':
      return updateScopeList(task, 'inBounds', value);
    case 'scope.outOfBounds':
      return updateScopeList(task, 'outOfBounds', value);
    case 'scope.approvedOutOfBounds':
      return updateScopeList(task, 'approvedOutOfBounds', value);
  }
}

function parseListValue(value: string): string[] {
  return value
    .split(/\r?\n/)
    .map((line) =>
      line
        .trim()
        .replace(/^(-|\d+\.)\s+/, '')
        .trim(),
    )
    .filter((line) => line.length > 0);
}

function stripOptionalArray(task: Task, key: 'escalation'): Task {
  const next = { ...task };
  delete next[key];
  return next;
}

function updateScopeList(
  task: Task,
  key: 'inBounds' | 'outOfBounds' | 'approvedOutOfBounds',
  value: string,
): Task {
  const nextScope = { ...task.scope, [key]: parseListValue(value) };
  if (
    (nextScope.inBounds ?? []).length === 0 &&
    (nextScope.outOfBounds ?? []).length === 0 &&
    (nextScope.approvedOutOfBounds ?? []).length === 0
  ) {
    const next = { ...task };
    delete next.scope;
    return next;
  }
  return { ...task, scope: nextScope };
}
