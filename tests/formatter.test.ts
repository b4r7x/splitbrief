import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { formatTaskPrompt, formatRetryPrompt, estimateTokens, truncateMiddle, computeTokenBudget, SYSTEM_PREAMBLE } from '../src/spec/formatter.js';
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
    typeDefs: '',
    implSteps: [],
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
    assert.ok(prompt.includes('Fix it:'));
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

  it('retry prompts include error and task context', () => {
    const retry1 = formatRetryPrompt(task, context, error, 1);
    const retry2 = formatRetryPrompt(task, context, error, 2);
    const retry3 = formatRetryPrompt(task, context, error, 3);

    assert.ok(retry1.includes(error));
    assert.ok(retry2.includes(error));
    assert.ok(retry3.includes(error));
    assert.ok(retry1.includes(task.file));
    assert.ok(retry2.includes(task.file));
    assert.ok(retry3.includes(task.file));
  });

  it('attempt 2 and 3 still include currentCode (v0.2: full context preserved)', () => {
    const modifyTask = makeTask({
      action: 'modify',
      currentCode: 'export function existing(): void { /* long code */ }\n',
    });
    const retry2 = formatRetryPrompt(modifyTask, context, error, 2);
    const retry3 = formatRetryPrompt(modifyTask, context, error, 3);

    assert.ok(retry2.includes('Current Code'));
    assert.ok(retry3.includes('Current Code'));
  });
});

describe('estimateTokens', () => {
  it('returns reasonable estimate for known text', () => {
    const tokens = estimateTokens('Hello, world!');
    assert.ok(tokens > 0);
    assert.equal(tokens, Math.ceil(13 / 4));
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

describe('computeTokenBudget', () => {
  it('returns correct token breakdown', () => {
    const budget = computeTokenBudget('system text', 'task body', 'type defs', 'impl steps', 8192);
    assert.strictEqual(budget.system, estimateTokens('system text'));
    assert.strictEqual(budget.taskBody, estimateTokens('task body'));
    assert.strictEqual(budget.typeDefs, estimateTokens('type defs'));
    assert.strictEqual(budget.implSteps, estimateTokens('impl steps'));
    assert.strictEqual(budget.codeContext, 0);
    assert.strictEqual(budget.outputReserve, Math.floor(8192 * 0.25));
    const expectedTotal = budget.system + budget.taskBody + budget.typeDefs + budget.implSteps + budget.outputReserve;
    assert.strictEqual(budget.total, expectedTotal);
    assert.strictEqual(budget.remaining, 8192 - expectedTotal);
  });

  it('25% output reserve', () => {
    const budget = computeTokenBudget('s', 't', 'd', 'i', 10000);
    assert.strictEqual(budget.outputReserve, Math.floor(10000 * 0.25));
  });

  it('remaining equals contextLength minus total', () => {
    const budget = computeTokenBudget('system prompt here', 'the task body text', 'interface Foo {}', 'step 1: do X', 16384);
    assert.strictEqual(budget.remaining, 16384 - budget.total);
  });

  it('small context (8K)', () => {
    const budget = computeTokenBudget('sys', 'task', 'types', 'steps', 8192);
    assert.strictEqual(budget.outputReserve, Math.floor(8192 * 0.25));
    assert.ok(budget.remaining > 0);
    assert.ok(budget.remaining < 8192);
    assert.strictEqual(budget.total + budget.remaining, 8192);
  });

  it('large context (32K)', () => {
    const budget = computeTokenBudget('sys', 'task', 'types', 'steps', 32768);
    assert.strictEqual(budget.outputReserve, Math.floor(32768 * 0.25));
    assert.ok(budget.remaining > 0);
    assert.ok(budget.remaining < 32768);
    assert.strictEqual(budget.total + budget.remaining, 32768);
    // Large context should have more remaining than small context with same inputs
    const smallBudget = computeTokenBudget('sys', 'task', 'types', 'steps', 8192);
    assert.ok(budget.remaining > smallBudget.remaining);
  });
});

describe('estimateTokens (token budgeting)', () => {
  it('empty string returns 0', () => {
    assert.strictEqual(estimateTokens(''), 0);
  });

  it('known length returns Math.ceil(length / 4)', () => {
    assert.strictEqual(estimateTokens('a'.repeat(100)), Math.ceil(100 / 4));
  });
});
