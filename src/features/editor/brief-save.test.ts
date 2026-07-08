import { isDeepStrictEqual } from 'node:util';
import { describe, it, expect } from 'vitest';
import { makeTask } from '#testing/helpers/factories/task.js';
import type { Task } from '../../core/schemas/task.js';
import { formatTasks } from '../../engine/spec/formatter.js';
import { parseTasksStrict } from '../../engine/spec/parser.js';
import { checkBriefSave } from './brief-save.js';

function validTask(overrides: Parameters<typeof makeTask>[0] = {}): Task {
  return makeTask({
    id: 'T001',
    title: 'Add greeting helper',
    action: 'create',
    file: 'src/greet.ts',
    description: 'Add a helper that returns a friendly greeting string.',
    signature: 'export function greet(name: string): string',
    pattern: 'follow the existing helper shape',
    tests: ['returns hello for an empty name', 'includes the provided name'],
    constraints: ['pure function', 'no external dependencies'],
    typeDefs: 'export type Greeting = string;',
    implementationSteps: ['define the greet function', 'export it from the module'],
    escalation: ['stop if the greeting format is ambiguous'],
    evidence: ['npm test passes', 'greet added'],
    scope: { inBounds: ['only greet'], outOfBounds: ['do not touch the barrel'] },
    ...overrides,
  });
}

describe('checkBriefSave', () => {
  it('accepts a single well-formed task', () => {
    expect(checkBriefSave([validTask()])).toEqual({ ok: true });
  });

  it('accepts a dependency chain that preserves closure', () => {
    const first = validTask();
    const second = validTask({
      id: 'T002',
      title: 'Wire the greeting into the entry point',
      file: 'src/main.ts',
      dependsOn: ['T001'],
    });
    expect(checkBriefSave([first, second])).toEqual({ ok: true });
  });

  it('round-trips every fixture deep-equal including multiline list fields', () => {
    const tasks = [
      validTask(),
      validTask({
        id: 'T002',
        title: 'Wire the greeting into the entry point',
        file: 'src/main.ts',
        dependsOn: ['T001'],
        tests: ['calls greet on boot', 'prints the returned string'],
        constraints: ['keep the entry point tiny', 'no top-level await'],
        implementationSteps: ['import greet', 'invoke it', 'print the result'],
        escalation: ['stop if the boot order is unclear', 'ask before touching startup'],
        evidence: ['boot log shows the greeting', 'npm start succeeds'],
      }),
    ];
    expect(isDeepStrictEqual(parseTasksStrict(formatTasks(tasks)), tasks)).toBe(true);
    expect(checkBriefSave(tasks)).toEqual({ ok: true });
  });

  it('rejects a lossy edit that fails the deep-equal round-trip', () => {
    const lossy = validTask({
      tests: ['returns hello for an empty name', 'includes the provided name '],
    });
    expect(isDeepStrictEqual(parseTasksStrict(formatTasks([lossy])), [lossy])).toBe(false);
    const result = checkBriefSave([lossy]);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected rejection');
    expect(result.message).toMatch(/round-trip|losing data/);
  });

  it('rejects an empty task list', () => {
    const result = checkBriefSave([]);
    expect(result.ok).toBe(false);
    expect(result).toEqual({ ok: false, message: 'Cannot save an empty task list.' });
  });

  it('rejects a cyclic dependency graph', () => {
    const a = validTask({ id: 'T001', dependsOn: ['T002'] });
    const b = validTask({ id: 'T002', file: 'src/other.ts', dependsOn: ['T001'] });
    const result = checkBriefSave([a, b]);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected rejection');
    expect(result.message).toMatch(/circular dependency/i);
  });

  it('rejects a brief-quality failure and surfaces the first error message', () => {
    const task = makeTask({
      id: 'T001',
      title: 'Add greeting helper',
      action: 'create',
      file: 'src/greet.ts',
      signature: 'export function greet(name: string): string',
      pattern: 'follow the existing helper shape',
      description: 'Add a helper that returns a friendly greeting string.',
      tests: ['returns hello for an empty name', 'includes the provided name'],
      constraints: ['pure function', 'no external dependencies'],
      typeDefs: 'export type Greeting = string;',
      implementationSteps: ['define the greet function', 'export it from the module'],
    });
    const result = checkBriefSave([task]);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected rejection');
    expect(result.message).toBe('Task T001 has no scope definition');
  });
});
