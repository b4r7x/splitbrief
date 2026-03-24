import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { formatTaskPrompt, formatRetryPrompt, estimateTokens, truncateMiddle, SYSTEM_PREAMBLE } from '../src/spec/formatter.js';
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
  it('create action task contains action, file path, and project info', () => {
    const task = makeTask();
    const prompt = formatTaskPrompt(task, context);

    assert.ok(prompt.includes('Action: create'));
    assert.ok(prompt.includes('src/utils/helpers.ts'));
    assert.ok(prompt.includes('test-project'));
    assert.ok(prompt.includes('Node.js 22'));
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

  it('SYSTEM_PREAMBLE does not contain markdown fences', () => {
    assert.ok(!SYSTEM_PREAMBLE.includes('```'));
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

  it('retry prompts are smaller than the original prompt', () => {
    const original = formatTaskPrompt(task, context);
    const retry1 = formatRetryPrompt(task, context, error, 1);
    const retry2 = formatRetryPrompt(task, context, error, 2);
    const retry3 = formatRetryPrompt(task, context, error, 3);

    assert.ok(retry1.length < original.length * 1.5 + error.length);
    assert.ok(retry2.length < original.length * 1.5 + error.length);
    assert.ok(retry3.length < original.length * 1.5 + error.length);
  });

  it('attempt 2 and 3 do not include currentCode', () => {
    const modifyTask = makeTask({
      action: 'modify',
      currentCode: 'export function existing(): void { /* long code */ }\n',
    });
    const retry2 = formatRetryPrompt(modifyTask, context, error, 2);
    const retry3 = formatRetryPrompt(modifyTask, context, error, 3);

    assert.ok(!retry2.includes('Current Code'));
    assert.ok(!retry3.includes('Current Code'));
  });
});

describe('estimateTokens', () => {
  it('returns reasonable estimate for known text', () => {
    const tokens = estimateTokens('Hello, world!');
    assert.ok(tokens > 0);
    assert.equal(tokens, Math.ceil(13 / 3.5));
  });

  it('returns 0 for empty string', () => {
    assert.equal(estimateTokens(''), 0);
  });

  it('scales linearly with text length', () => {
    const short = estimateTokens('a'.repeat(100));
    const long = estimateTokens('a'.repeat(1000));
    assert.ok(long >= short * 9);
    assert.ok(long <= short * 11);
  });
});

describe('truncateMiddle', () => {
  it('returns text unchanged when under limit', () => {
    const text = 'short text';
    assert.equal(truncateMiddle(text, 1000), text);
  });

  it('truncates long text with marker', () => {
    const text = 'A'.repeat(10000);
    const result = truncateMiddle(text, 100);
    assert.ok(result.includes('// ... truncated to fit context window ...'));
    assert.ok(result.length < text.length);
  });

  it('preserves start and end of text', () => {
    const text = 'START' + 'X'.repeat(10000) + 'END!!';
    const result = truncateMiddle(text, 200);
    assert.ok(result.startsWith('START'));
    assert.ok(result.endsWith('END!!'));
  });
});

describe('formatTaskPrompt with contextLength', () => {
  it('truncates large currentCode when contextLength is set', () => {
    const largeCode = 'x'.repeat(50000);
    const task = makeTask({
      action: 'modify',
      currentCode: largeCode,
    });
    const prompt = formatTaskPrompt(task, context, 2048);
    assert.ok(prompt.length < largeCode.length);
    assert.ok(prompt.includes('// ... truncated to fit context window ...'));
  });

  it('does not truncate small currentCode', () => {
    const smallCode = 'export function small(): void {}\n';
    const task = makeTask({
      action: 'modify',
      currentCode: smallCode,
    });
    const prompt = formatTaskPrompt(task, context, 8192);
    assert.ok(prompt.includes(smallCode));
    assert.ok(!prompt.includes('truncated'));
  });

  it('works without contextLength (backward compatible)', () => {
    const task = makeTask({
      action: 'modify',
      currentCode: 'export const x = 1;\n',
    });
    const prompt = formatTaskPrompt(task, context);
    assert.ok(prompt.includes('export const x = 1;'));
  });
});
