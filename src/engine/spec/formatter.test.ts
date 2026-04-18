import { describe, it, expect } from 'vitest';
import { formatTaskPrompt, formatRetryPrompt } from './formatter.js';
import { estimateTokens, truncateMiddle, computeTokenBudget } from './token-budget.js';
import { makeTask as makeBaseTask } from '#testing/helpers/factories/task.js';
import { defaultContext } from '#testing/helpers/factories/config.js';
import type { Task } from '../../core/schemas/task.js';

const context = { ...defaultContext, testCommand: 'node --test' };

function makeTask(overrides: Partial<Task> = {}): Task {
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
    const prompt = formatTaskPrompt(task, context);

    expect(prompt).toContain('Action: create');
    expect(prompt).toContain('src/utils/helpers.ts');
    expect(prompt).toContain('test-project');
    expect(prompt).toContain('Node.js 22');
  });

  it('modify action task with currentCode contains Current Code section', () => {
    const task = makeTask({
      action: 'modify',
      currentCode: 'export function old(): void {}\n',
    });
    const prompt = formatTaskPrompt(task, context);

    expect(prompt).toContain('Current Code');
    expect(prompt).toContain('export function old(): void {}');
  });

  it('task with signature contains Function Signature section', () => {
    const task = makeTask({
      signature: 'export function greet(name: string): string',
    });
    const prompt = formatTaskPrompt(task, context);

    expect(prompt).toContain('### Function Signature');
    expect(prompt).toContain('export function greet(name: string): string');
  });

  it('task with tests contains Tests section with all test items', () => {
    const task = makeTask({
      tests: ['Should handle empty input', 'Should trim whitespace', 'Should return lowercase'],
    });
    const prompt = formatTaskPrompt(task, context);

    expect(prompt).toContain('### Tests');
    expect(prompt).toContain('Should handle empty input');
    expect(prompt).toContain('Should trim whitespace');
    expect(prompt).toContain('Should return lowercase');
  });

  it('task with constraints contains Constraints section', () => {
    const task = makeTask({
      constraints: ['Must be pure function', 'No side effects'],
    });
    const prompt = formatTaskPrompt(task, context);

    expect(prompt).toContain('### Constraints');
    expect(prompt).toContain('- Must be pure function');
    expect(prompt).toContain('- No side effects');
  });

  it('prompt ends with output instruction (lost-in-middle mitigation)', () => {
    const task = makeTask();
    const prompt = formatTaskPrompt(task, context);
    const lastLine = prompt.trimEnd().split('\n').at(-1)!;

    expect(lastLine).toContain('Output the complete file contents');
    expect(lastLine).toContain('No markdown fences');
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
    const prompt = formatRetryPrompt(task, context, error, attempt);
    expect(prompt).toContain(expectedText);
    expect(prompt).toContain(error);
    expect(prompt).toContain(task.file);
  });

  it('attempt 2 and 3 still include currentCode (v0.2: full context preserved)', () => {
    const modifyTask = makeTask({
      action: 'modify',
      currentCode: 'export function existing(): void { /* long code */ }\n',
    });
    const retry2 = formatRetryPrompt(modifyTask, context, error, 2);
    const retry3 = formatRetryPrompt(modifyTask, context, error, 3);

    expect(retry2).toContain('Current Code');
    expect(retry3).toContain('Current Code');
  });
});

describe('estimateTokens', () => {
  it('returns reasonable estimate for known text', () => {
    const tokens = estimateTokens('Hello, world!');
    expect(tokens).toBeGreaterThan(0);
    expect(tokens).toBe(Math.ceil(13 / 4));
  });

  it('returns 0 for empty string', () => {
    expect(estimateTokens('')).toBe(0);
  });

});

describe('truncateMiddle', () => {
  it('returns text unchanged when under limit', () => {
    const text = 'short text';
    expect(truncateMiddle(text, 1000)).toBe(text);
  });

  it('truncates long text with marker', () => {
    const text = 'A'.repeat(10000);
    const result = truncateMiddle(text, 100);
    expect(result).toContain('// ... truncated to fit context window ...');
    expect(result.length).toBeLessThan(text.length);
  });

  it('preserves start and end of text', () => {
    const text = 'START' + 'X'.repeat(10000) + 'END!!';
    const result = truncateMiddle(text, 200);
    expect(result.startsWith('START')).toBeTruthy();
    expect(result.endsWith('END!!')).toBeTruthy();
  });

  it('returns no more characters than the input when the budget is tiny', () => {
    const text = 'some content here';
    const result = truncateMiddle(text, 1);
    expect(result.length).toBeLessThanOrEqual(text.length);
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
    expect(prompt.length).toBeLessThan(largeCode.length);
    expect(prompt).toContain('// ... truncated to fit context window ...');
  });

  it('does not truncate small currentCode', () => {
    const smallCode = 'export function small(): void {}\n';
    const task = makeTask({
      action: 'modify',
      currentCode: smallCode,
    });
    const prompt = formatTaskPrompt(task, context, 8192);
    expect(prompt).toContain(smallCode);
    expect(prompt).not.toContain('truncated');
  });

  it('works without contextLength (backward compatible)', () => {
    const task = makeTask({
      action: 'modify',
      currentCode: 'export const x = 1;\n',
    });
    const prompt = formatTaskPrompt(task, context);
    expect(prompt).toContain('export const x = 1;');
  });
});

describe('computeTokenBudget', () => {
  it('returns correct token breakdown', () => {
    const budget = computeTokenBudget('system text', 'task body', 8192);
    expect(budget.system).toBe(estimateTokens('system text'));
    expect(budget.taskBody).toBe(estimateTokens('task body'));
    expect(budget.outputReserve).toBe(Math.floor(8192 * 0.25));
    const expectedTotal = budget.system + budget.taskBody + budget.outputReserve;
    expect(budget.total).toBe(expectedTotal);
    expect(budget.remaining).toBe(8192 - expectedTotal);
  });

  it('remaining equals contextLength minus total', () => {
    const budget = computeTokenBudget('system prompt here', 'the task body text', 16384);
    expect(budget.remaining).toBe(16384 - budget.total);
  });

  it('remaining decreases as system prompt grows', () => {
    const small = computeTokenBudget('short', 'task', 8192);
    const large = computeTokenBudget('a'.repeat(2000), 'task', 8192);
    expect(large.remaining).toBeLessThan(small.remaining);
  });

  it('can produce negative remaining when context is too small', () => {
    const budget = computeTokenBudget('a'.repeat(4000), 'b'.repeat(4000), 100);
    expect(budget.remaining).toBeLessThan(0);
  });

});
