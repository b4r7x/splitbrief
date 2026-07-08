import { describe, it, expect } from 'vitest';
import { makeTask } from '#testing/helpers/factories/task.js';
import type { Task } from '../../core/schemas/task.js';
import {
  type EditableBriefField,
  briefFieldList,
  readField,
  writeField,
} from './brief-field-model.js';

const ALL_FIELDS: EditableBriefField[] = [
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

function richTask(): Task {
  return makeTask({
    id: 'T002',
    title: 'Add greeting helper',
    action: 'modify',
    file: 'src/greet.ts',
    dependsOn: ['T001'],
    status: 'in_progress',
    description: 'Add a helper that returns a friendly greeting string.',
    signature: 'export function greet(name: string): string',
    currentCode: 'export function greet(): string { return ""; }',
    typeDefs: 'export type Greeting = string;',
    tests: ['returns hello for an empty name', 'includes the provided name'],
    constraints: ['pure function', 'no external dependencies'],
    implementationSteps: ['define the greet function', 'export it from the module'],
    escalation: ['stop if the greeting format is ambiguous', 'ask before adding a dependency'],
    evidence: ['npm test passes', 'greet added'],
    scope: { inBounds: ['only greet'], outOfBounds: ['do not touch the barrel'] },
  });
}

describe('writeField', () => {
  it.each(ALL_FIELDS)('returns a NEW Task with id/dependsOn/action/status intact (%s)', (field) => {
    const task = richTask();
    const next = writeField(task, field, 'replacement line one\nreplacement line two');

    expect(next).not.toBe(task);
    expect(next.id).toBe(task.id);
    expect(next.dependsOn).toEqual(task.dependsOn);
    expect(next.action).toBe(task.action);
    expect(next.status).toBe(task.status);
  });

  it('never mutates the input task', () => {
    const task = richTask();
    const snapshot = structuredClone(task);
    writeField(task, 'title', 'a totally different title');
    expect(task).toEqual(snapshot);
  });

  it('round-trips a single-line text field through readField', () => {
    const task = richTask();
    const next = writeField(task, 'title', 'Renamed task');
    expect(readField(next, 'title')).toBe('Renamed task');
    expect(next.title).toBe('Renamed task');
  });

  it('round-trips a multiline list field through readField', () => {
    const task = richTask();
    const next = writeField(task, 'tests', 'first assertion\nsecond assertion\nthird assertion');
    expect(next.tests).toEqual(['first assertion', 'second assertion', 'third assertion']);
    expect(readField(next, 'tests')).toBe('first assertion\nsecond assertion\nthird assertion');
  });

  it('drops blank lines when splitting a list field', () => {
    const task = richTask();
    const next = writeField(task, 'constraints', 'keep this\n\n   \nand this');
    expect(next.constraints).toEqual(['keep this', 'and this']);
  });

  it('writes nested scope buckets without touching the sibling bucket', () => {
    const task = richTask();
    const next = writeField(task, 'scopeInBounds', 'only the model file');
    expect(next.scope?.inBounds).toEqual(['only the model file']);
    expect(next.scope?.outOfBounds).toEqual(task.scope?.outOfBounds);
  });
});

describe('briefFieldList', () => {
  it('returns present fields in canonical Tab order', () => {
    expect(briefFieldList(richTask())).toEqual(ALL_FIELDS);
  });

  it('omits fields whose value is empty', () => {
    const task = makeTask({
      id: 'T001',
      title: 'Bare task',
      file: 'src/bare.ts',
      description: 'A bare task.',
      tests: ['does the thing'],
      implementationSteps: ['do the thing'],
    });
    const fields = briefFieldList(task);
    expect(fields).toContain('title');
    expect(fields).toContain('tests');
    expect(fields).not.toContain('scopeInBounds');
    expect(fields).not.toContain('evidence');
    expect(fields).not.toContain('signature');
  });
});
