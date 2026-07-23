import { describe, it, expect } from 'vitest';
import { formatTaskPrompt, formatRetryPrompt } from './prompt-formatter.js';
import { makeTask as makeBaseTask } from '#testing/helpers/factories/task.js';
import { defaultContext } from '#testing/helpers/factories/config.js';
import type { Task } from '../../core/schemas/task.js';

const context = defaultContext;

type TaskOverrides = Omit<Partial<Task>, 'id' | 'dependsOn'> & {
  id?: string;
  dependsOn?: string[];
};

function makeTask(overrides: TaskOverrides = {}): Task {
  return makeBaseTask({
    title: 'Create utility module',
    file: 'src/utils/helpers.ts',
    description: 'Implement helper functions for string manipulation.',
    ...overrides,
  });
}

describe('formatTaskPrompt', () => {
  it('create action task contains action, file path, and project info', () => {
    const task = makeTask();
    const prompt = formatTaskPrompt({ task, context });

    expect(prompt).toContain('Action: create');
    expect(prompt).toContain('src/utils/helpers.ts');
    expect(prompt).toContain('test-project');
  });

  it('modify action task with currentCode contains Current Code section', () => {
    const task = makeTask({
      action: 'modify',
      currentCode: 'export function old(): void {}\n',
    });
    const prompt = formatTaskPrompt({ task, context });

    expect(prompt).toContain('Current Code');
    expect(prompt).toContain('export function old(): void {}');
  });

  it('task with signature contains the canonical Signature section', () => {
    const task = makeTask({
      signature: 'export function greet(name: string): string',
    });
    const prompt = formatTaskPrompt({ task, context });

    expect(prompt).toContain('### Signature');
    expect(prompt).toContain('export function greet(name: string): string');
  });

  it('task with tests contains Tests section with all test items', () => {
    const task = makeTask({
      tests: ['Should handle empty input', 'Should trim whitespace', 'Should return lowercase'],
    });
    const prompt = formatTaskPrompt({ task, context });

    expect(prompt).toContain('### Tests');
    expect(prompt).toContain('- Should handle empty input');
    expect(prompt).toContain('- Should trim whitespace');
    expect(prompt).toContain('- Should return lowercase');
  });

  it('task with a pattern keeps the codebase pattern in the implementer brief', () => {
    const task = makeTask({
      pattern: 'Follow the existing parseConfig(raw) guard shape.',
    });
    const prompt = formatTaskPrompt({ task, context });

    expect(prompt).toContain('### Pattern');
    expect(prompt).toContain('Follow the existing parseConfig(raw) guard shape.');
  });

  it('task with constraints contains Constraints section', () => {
    const task = makeTask({
      constraints: ['Must be pure function', 'No side effects'],
    });
    const prompt = formatTaskPrompt({ task, context });

    expect(prompt).toContain('### Constraints');
    expect(prompt).toContain('- Must be pure function');
    expect(prompt).toContain('- No side effects');
  });

  it('prompt ends with output instruction (lost-in-middle mitigation)', () => {
    const task = makeTask();
    const prompt = formatTaskPrompt({ task, context });
    const lastLine = prompt.trimEnd().split('\n').at(-1)!;

    expect(lastLine).toContain('Output the complete file contents');
    expect(lastLine).toContain('No markdown fences');
  });

  it('omits Scope / Escalation / Evidence sections when the brief has none', () => {
    const task = makeTask();
    const prompt = formatTaskPrompt({ task, context });
    expect(prompt).not.toContain('### Scope');
    expect(prompt).not.toContain('### Escalation');
    expect(prompt).not.toContain('### Evidence');
  });

  it('renders Scope with In bounds / Out of bounds bullets when present', () => {
    const task = makeTask({
      scope: {
        inBounds: ['only touch helpers.ts'],
        outOfBounds: ['do not modify SignupForm'],
      },
    });
    const prompt = formatTaskPrompt({ task, context });
    expect(prompt).toContain('### Scope');
    expect(prompt).toContain('**In bounds:**');
    expect(prompt).toContain('- only touch helpers.ts');
    expect(prompt).toContain('**Out of bounds:**');
    expect(prompt).toContain('- do not modify SignupForm');
  });

  it('renders Scope with only the bucket that has bullets', () => {
    const task = makeTask({ scope: { inBounds: ['just this file'] } });
    const prompt = formatTaskPrompt({ task, context });
    expect(prompt).toContain('### Scope');
    expect(prompt).toContain('**In bounds:**');
    expect(prompt).not.toContain('**Out of bounds:**');
  });

  it('renders Escalation bullets when present so the implementer knows when to stop', () => {
    const task = makeTask({
      escalation: ['ambiguous error message format', 'missing dependency'],
    });
    const prompt = formatTaskPrompt({ task, context });
    expect(prompt).toContain('### Escalation');
    expect(prompt).toContain('- ambiguous error message format');
    expect(prompt).toContain('- missing dependency');
  });

  it('renders Evidence bullets when present so the proof to leave behind is explicit', () => {
    const task = makeTask({
      evidence: ['npm test passes', 'changed file list'],
    });
    const prompt = formatTaskPrompt({ task, context });
    expect(prompt).toContain('### Evidence');
    expect(prompt).toContain('- npm test passes');
    expect(prompt).toContain('- changed file list');
  });

  it('places Scope / Escalation / Evidence after Tests and before Constraints', () => {
    const task = makeTask({
      tests: ['returns true'],
      scope: { inBounds: ['file A'] },
      escalation: ['ambiguous A'],
      evidence: ['proof A'],
      constraints: ['pure function'],
    });
    const prompt = formatTaskPrompt({ task, context });
    const idxTests = prompt.indexOf('### Tests');
    const idxScope = prompt.indexOf('### Scope');
    const idxEsc = prompt.indexOf('### Escalation');
    const idxEvidence = prompt.indexOf('### Evidence');
    const idxConstraints = prompt.indexOf('### Constraints');

    expect(idxTests).toBeGreaterThan(-1);
    expect(idxScope).toBeGreaterThan(idxTests);
    expect(idxEsc).toBeGreaterThan(idxScope);
    expect(idxEvidence).toBeGreaterThan(idxEsc);
    expect(idxConstraints).toBeGreaterThan(idxEvidence);
  });

  it('retry prompt surfaces Scope / Escalation / Evidence and keeps the retry framing', () => {
    const task = makeTask({
      scope: { outOfBounds: ['no schema changes'] },
      escalation: ['stop on type error in shared schema'],
      evidence: ['typecheck output'],
    });
    const prompt = formatRetryPrompt({ task, context, error: 'boom', attempt: 1 });
    expect(prompt).toContain('Fix it:');
    expect(prompt).toContain('### Scope');
    expect(prompt).toContain('- no schema changes');
    expect(prompt).toContain('### Escalation');
    expect(prompt).toContain('- stop on type error in shared schema');
    expect(prompt).toContain('### Evidence');
    expect(prompt).toContain('- typecheck output');
  });
});

describe('formatRetryPrompt', () => {
  const task = makeTask();
  const error = 'TypeError: Cannot read property x of undefined';

  it.each([
    [1, 'Fix it:'],
    [2, 'rephrased'],
    [3, 'different approach'],
  ] as const)('attempt %i contains expected framing', (attempt, expectedText) => {
    const prompt = formatRetryPrompt({ task, context, error, attempt });
    expect(prompt).toContain(expectedText);
    expect(prompt).toContain(error);
    expect(prompt).toContain(task.file);
  });

  it('attempt 2 and 3 still include currentCode (v0.2: full context preserved)', () => {
    const modifyTask = makeTask({
      action: 'modify',
      currentCode: 'export function existing(): void { /* long code */ }\n',
    });
    const retry2 = formatRetryPrompt({ task: modifyTask, context, error, attempt: 2 });
    const retry3 = formatRetryPrompt({ task: modifyTask, context, error, attempt: 3 });

    expect(retry2).toContain('Current Code');
    expect(retry3).toContain('Current Code');
  });
});
