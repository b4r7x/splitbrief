import { describe, it, expect } from 'vitest';
import { formatTaskPrompt } from './prompt-formatter.js';
import { estimateTokens } from '../../core/tokens/estimate.js';
import { DEFAULT_UNKNOWN_CONTEXT_LENGTH } from '../../core/tokens/context-length.js';
import { truncateMiddle, computeTokenBudget } from './token-budget.js';
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

describe('truncateMiddle', () => {
  it('keeps small text unchanged and preserves both ends when truncating long text', () => {
    expect(truncateMiddle('short text', 1000)).toBe('short text');

    const text = 'START' + 'X'.repeat(10000) + 'END!!';
    const result = truncateMiddle(text, 200);

    expect(result).toContain('// ... truncated to fit context window ...');
    expect(result.length).toBeLessThan(text.length);
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
    const prompt = formatTaskPrompt({ task, context, contextLength: 2048 });
    expect(prompt.length).toBeLessThan(largeCode.length);
    expect(prompt).toContain('// ... truncated to fit context window ...');
  });

  it('does not truncate small currentCode', () => {
    const smallCode = 'export function small(): void {}\n';
    const task = makeTask({
      action: 'modify',
      currentCode: smallCode,
    });
    const prompt = formatTaskPrompt({ task, context, contextLength: 8192 });
    expect(prompt).toContain(smallCode);
    expect(prompt).not.toContain('truncated');
  });

  it('places current code inside Code Context before implementation steps', () => {
    const task = makeTask({
      action: 'modify',
      currentCode: 'export function greet(): string { return "hi"; }\n',
      implementationSteps: ['Update greet to accept a name'],
      tests: ['returns a personalized greeting'],
    });
    const prompt = formatTaskPrompt({ task, context });

    const idxCurrentCode = prompt.indexOf('### Current Code');
    const idxSteps = prompt.indexOf('### Implementation Steps');
    const idxTests = prompt.indexOf('### Tests');

    expect(idxCurrentCode).toBeGreaterThan(-1);
    expect(idxSteps).toBeGreaterThan(idxCurrentCode);
    expect(idxTests).toBeGreaterThan(idxSteps);
  });

  it('uses plain code context labels when only the target function fits', () => {
    const task = makeTask({
      action: 'modify',
      signature: 'export function target(): string',
      currentCode: [
        "import { helper } from './helper.js';",
        '',
        `const fixture = '${'x'.repeat(40_000)}';`,
        '',
        'export function other(): string {',
        "  return 'ok';",
        '}',
        '',
        'export function target(): string {',
        '  return helper();',
        '}',
      ].join('\n'),
    });
    const prompt = formatTaskPrompt({ task, context, contextLength: 4096 });

    expect(prompt).toContain('#### Imports');
    expect(prompt).toContain('#### Target Function');
    expect(prompt).toContain('#### Other Exports (do not modify): other');
    expect(prompt).not.toContain('// ===');
  });

  it('inserts currentCode unbudgeted when contextLength is omitted (callers supply their own default)', () => {
    const task = makeTask({
      action: 'modify',
      currentCode: 'export const x = 1;\n',
    });
    const prompt = formatTaskPrompt({ task, context });
    expect(prompt).toContain('export const x = 1;');
    expect(prompt).not.toContain('truncated');
  });

  it('truncates large currentCode at the shared default context window when that window is passed', () => {
    const largeCode = 'x'.repeat(150_000);
    const task = makeTask({
      action: 'modify',
      currentCode: largeCode,
    });
    const prompt = formatTaskPrompt({
      task,
      context,
      contextLength: DEFAULT_UNKNOWN_CONTEXT_LENGTH,
    });

    expect(prompt).toContain('// ... truncated to fit context window ...');
    expect(prompt.length).toBeLessThan(largeCode.length);
  });
});

describe('computeTokenBudget', () => {
  it('returns a consistent token breakdown', () => {
    const budget = computeTokenBudget({
      system: 'system text',
      taskBody: 'task body',
      contextLength: 8192,
    });
    expect(budget.system).toBe(estimateTokens('system text'));
    expect(budget.taskBody).toBe(estimateTokens('task body'));
    expect(budget.outputReserve).toBe(Math.floor(8192 * 0.25));
    const expectedTotal = budget.system + budget.taskBody + budget.outputReserve;
    expect(budget.total).toBe(expectedTotal);
    expect(budget.remaining).toBe(8192 - expectedTotal);
  });

  it('remaining tracks prompt size and can go negative when context is too small', () => {
    const small = computeTokenBudget({ system: 'short', taskBody: 'task', contextLength: 8192 });
    const large = computeTokenBudget({
      system: 'a'.repeat(2000),
      taskBody: 'task',
      contextLength: 8192,
    });
    const tooSmall = computeTokenBudget({
      system: 'a'.repeat(4000),
      taskBody: 'b'.repeat(4000),
      contextLength: 100,
    });

    expect(large.remaining).toBeLessThan(small.remaining);
    expect(tooSmall.remaining).toBeLessThan(0);
  });
});
