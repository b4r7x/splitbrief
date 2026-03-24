import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { formatTaskPrompt, formatRetryPrompt } from '../src/spec/formatter.js';
import type { Task, ProjectContext } from '../src/types.js';

const context: ProjectContext = {
  name: 'test-project',
  dir: '/tmp/test-project',
  runtime: 'Node.js 22',
  testCommand: 'node --test',
};

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: 'T001',
    title: 'Create utility module',
    action: 'create',
    file: 'src/utils/helpers.ts',
    dependsOn: [],
    description: 'Implement helper functions for string manipulation.',
    tests: [],
    constraints: [],
    status: 'pending',
    ...overrides,
  };
}

describe('formatTaskPrompt', () => {
  it('create action task contains action, file path, and system prompt rules', () => {
    const task = makeTask();
    const prompt = formatTaskPrompt(task, context);

    assert.ok(prompt.includes('Action: create'));
    assert.ok(prompt.includes('src/utils/helpers.ts'));
    assert.ok(prompt.includes('Do NOT include markdown code fences'));
    assert.ok(prompt.includes('Use ESM imports with .js extensions'));
  });

  it('modify action task with currentCode contains Current Code section', () => {
    const task = makeTask({
      action: 'modify',
      currentCode: 'export function old(): void {}\n',
    });
    const prompt = formatTaskPrompt(task, context);

    assert.ok(prompt.includes('Current Code'));
    assert.ok(prompt.includes('export function old(): void {}'));
  });

  it('task with signature contains Function Signature section', () => {
    const task = makeTask({
      signature: 'export function greet(name: string): string',
    });
    const prompt = formatTaskPrompt(task, context);

    assert.ok(prompt.includes('### Function Signature'));
    assert.ok(prompt.includes('export function greet(name: string): string'));
  });

  it('task with tests contains Tests section with all test items', () => {
    const task = makeTask({
      tests: ['Should handle empty input', 'Should trim whitespace', 'Should return lowercase'],
    });
    const prompt = formatTaskPrompt(task, context);

    assert.ok(prompt.includes('### Tests'));
    assert.ok(prompt.includes('Should handle empty input'));
    assert.ok(prompt.includes('Should trim whitespace'));
    assert.ok(prompt.includes('Should return lowercase'));
  });

  it('task with constraints contains Constraints section', () => {
    const task = makeTask({
      constraints: ['Must be pure function', 'No side effects'],
    });
    const prompt = formatTaskPrompt(task, context);

    assert.ok(prompt.includes('### Constraints'));
    assert.ok(prompt.includes('- Must be pure function'));
    assert.ok(prompt.includes('- No side effects'));
  });

  it('prompt ends with output instruction (lost-in-middle mitigation)', () => {
    const task = makeTask();
    const prompt = formatTaskPrompt(task, context);
    const lastLine = prompt.trimEnd().split('\n').at(-1)!;

    assert.ok(lastLine.includes('Output the complete file contents'));
    assert.ok(lastLine.includes('No markdown fences'));
  });

  it('system instruction does not contain markdown fences', () => {
    const task = makeTask();
    const prompt = formatTaskPrompt(task, context);
    const systemBlock = prompt.split('## Task:')[0];

    assert.ok(!systemBlock.includes('```'));
  });
});

describe('formatRetryPrompt', () => {
  const task = makeTask();
  const error = 'TypeError: Cannot read property x of undefined';

  it('attempt 1 contains error message and fix instruction', () => {
    const prompt = formatRetryPrompt(task, context, error, 1);

    assert.ok(prompt.includes(error));
    assert.ok(prompt.includes('Fix the error'));
  });

  it('attempt 2 contains rephrased task', () => {
    const prompt = formatRetryPrompt(task, context, error, 2);

    assert.ok(prompt.includes('rephrased'));
    assert.ok(prompt.includes(task.file));
    assert.ok(prompt.includes(task.title));
    assert.ok(prompt.includes(error));
  });

  it('attempt 3 contains different approach instruction', () => {
    const prompt = formatRetryPrompt(task, context, error, 3);

    assert.ok(prompt.includes('different approach'));
    assert.ok(prompt.includes(error));
  });
});
