import type { Task } from '../../core/schemas/task.js';

export type EditableBriefField =
  | 'title'
  | 'file'
  | 'description'
  | 'signature'
  | 'currentCode'
  | 'typeDefs'
  | 'tests'
  | 'constraints'
  | 'implementationSteps'
  | 'escalation'
  | 'evidence'
  | 'scopeInBounds'
  | 'scopeOutOfBounds';

const FIELD_ORDER: EditableBriefField[] = [
  'title',
  'file',
  'description',
  'signature',
  'currentCode',
  'typeDefs',
  'tests',
  'constraints',
  'implementationSteps',
  'escalation',
  'evidence',
  'scopeInBounds',
  'scopeOutOfBounds',
];

function splitList(text: string): string[] {
  return text.split('\n').filter((line) => line.trim().length > 0);
}

export function readField(task: Task, field: EditableBriefField): string {
  switch (field) {
    case 'title':
      return task.title;
    case 'file':
      return task.file;
    case 'description':
      return task.description;
    case 'signature':
      return task.signature ?? '';
    case 'currentCode':
      return task.currentCode ?? '';
    case 'typeDefs':
      return task.typeDefs;
    case 'tests':
      return task.tests.join('\n');
    case 'constraints':
      return task.constraints.join('\n');
    case 'implementationSteps':
      return task.implementationSteps.join('\n');
    case 'escalation':
      return (task.escalation ?? []).join('\n');
    case 'evidence':
      return (task.evidence ?? []).join('\n');
    case 'scopeInBounds':
      return (task.scope?.inBounds ?? []).join('\n');
    case 'scopeOutOfBounds':
      return (task.scope?.outOfBounds ?? []).join('\n');
  }
}

export function writeField(task: Task, field: EditableBriefField, text: string): Task {
  switch (field) {
    case 'title':
      return { ...task, title: text };
    case 'file':
      return { ...task, file: text };
    case 'description':
      return { ...task, description: text };
    case 'signature':
      return { ...task, signature: text };
    case 'currentCode':
      return { ...task, currentCode: text };
    case 'typeDefs':
      return { ...task, typeDefs: text };
    case 'tests':
      return { ...task, tests: splitList(text) };
    case 'constraints':
      return { ...task, constraints: splitList(text) };
    case 'implementationSteps':
      return { ...task, implementationSteps: splitList(text) };
    case 'escalation':
      return { ...task, escalation: splitList(text) };
    case 'evidence':
      return { ...task, evidence: splitList(text) };
    case 'scopeInBounds':
      return { ...task, scope: { ...task.scope, inBounds: splitList(text) } };
    case 'scopeOutOfBounds':
      return { ...task, scope: { ...task.scope, outOfBounds: splitList(text) } };
  }
}

export function briefFieldList(task: Task): EditableBriefField[] {
  return FIELD_ORDER.filter((field) => readField(task, field).length > 0);
}
