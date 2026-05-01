import { describe, it, expect } from 'vitest';
import { formatTaskPrompt, formatRetryPrompt } from './prompt-formatter.js';
import { formatTasks } from './formatter.js';
import { parseTasks } from './parser.js';
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

  it('task with signature contains the canonical Signature section', () => {
    const task = makeTask({
      signature: 'export function greet(name: string): string',
    });
    const prompt = formatTaskPrompt(task, context);

    expect(prompt).toContain('### Signature');
    expect(prompt).toContain('export function greet(name: string): string');
  });

  it('task with tests contains Tests section with all test items', () => {
    const task = makeTask({
      tests: ['Should handle empty input', 'Should trim whitespace', 'Should return lowercase'],
    });
    const prompt = formatTaskPrompt(task, context);

    expect(prompt).toContain('### Tests');
    expect(prompt).toContain('- Should handle empty input');
    expect(prompt).toContain('- Should trim whitespace');
    expect(prompt).toContain('- Should return lowercase');
  });

  it('task with a pattern keeps the codebase pattern in the implementer brief', () => {
    const task = makeTask({
      pattern: 'Follow the existing parseConfig(raw) guard shape.',
    });
    const prompt = formatTaskPrompt(task, context);

    expect(prompt).toContain('### Pattern');
    expect(prompt).toContain('Follow the existing parseConfig(raw) guard shape.');
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

  it('omits Scope / Escalation / Evidence sections when the brief has none', () => {
    const task = makeTask();
    const prompt = formatTaskPrompt(task, context);
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
    const prompt = formatTaskPrompt(task, context);
    expect(prompt).toContain('### Scope');
    expect(prompt).toContain('**In bounds:**');
    expect(prompt).toContain('- only touch helpers.ts');
    expect(prompt).toContain('**Out of bounds:**');
    expect(prompt).toContain('- do not modify SignupForm');
  });

  it('renders Scope with only the bucket that has bullets', () => {
    const task = makeTask({ scope: { inBounds: ['just this file'] } });
    const prompt = formatTaskPrompt(task, context);
    expect(prompt).toContain('### Scope');
    expect(prompt).toContain('**In bounds:**');
    expect(prompt).not.toContain('**Out of bounds:**');
  });

  it('renders Escalation bullets when present so the implementer knows when to stop', () => {
    const task = makeTask({
      escalation: ['ambiguous error message format', 'missing dependency'],
    });
    const prompt = formatTaskPrompt(task, context);
    expect(prompt).toContain('### Escalation');
    expect(prompt).toContain('- ambiguous error message format');
    expect(prompt).toContain('- missing dependency');
  });

  it('renders Evidence bullets when present so the proof to leave behind is explicit', () => {
    const task = makeTask({
      evidence: ['npm test passes', 'changed file list'],
    });
    const prompt = formatTaskPrompt(task, context);
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
    const prompt = formatTaskPrompt(task, context);
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
    const prompt = formatRetryPrompt(task, context, 'boom', 1);
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

  it('places current code inside Code Context before implementation steps', () => {
    const task = makeTask({
      action: 'modify',
      currentCode: 'export function greet(): string { return "hi"; }\n',
      implementationSteps: ['Update greet to accept a name'],
      tests: ['returns a personalized greeting'],
    });
    const prompt = formatTaskPrompt(task, context);

    const idxCurrentCode = prompt.indexOf('### Current Code');
    const idxSteps = prompt.indexOf('### Implementation Steps');
    const idxTests = prompt.indexOf('### Tests');

    expect(idxCurrentCode).toBeGreaterThan(-1);
    expect(idxSteps).toBeGreaterThan(idxCurrentCode);
    expect(idxTests).toBeGreaterThan(idxSteps);
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

describe('formatTasks', () => {
  it('empty array returns empty string', () => {
    expect(formatTasks([])).toBe('');
  });

  it('empty string parses to empty array (round-trip boundary)', () => {
    expect(parseTasks('')).toEqual([]);
  });

  it('single task round-trips: id is preserved', () => {
    const task = makeTask({ implementationSteps: ['step one'], tests: ['returns x'], constraints: ['pure'] });
    const markdown = formatTasks([task]);
    const parsed = parseTasks(markdown);
    expect(parsed).toHaveLength(1);
    expect(parsed[0]?.id).toBe(task.id);
  });

  it('single task round-trips: title, action, file are preserved', () => {
    const task = makeTask({ title: 'My Task', action: 'modify', file: 'src/foo.ts', implementationSteps: ['do it'], tests: ['works'] });
    const parsed = parseTasks(formatTasks([task]));
    expect(parsed[0]?.title).toBe('My Task');
    expect(parsed[0]?.action).toBe('modify');
    expect(parsed[0]?.file).toBe('src/foo.ts');
  });

  it('two tasks round-trip: both tasks are returned', () => {
    const t1 = makeTask({ title: 'First', implementationSteps: ['step 1'], tests: ['test A'] });
    const t2 = makeBaseTask({ id: 'T002', title: 'Second', file: 'src/bar.ts', description: 'Do bar', implementationSteps: ['step 2'], tests: ['test B'] });
    const markdown = formatTasks([t1, t2]);
    const parsed = parseTasks(markdown);
    expect(parsed).toHaveLength(2);
  });

  it('depends_on round-trips', () => {
    const t1 = makeTask({ implementationSteps: ['step 1'], tests: ['test A'] });
    const t2 = makeBaseTask({ id: 'T002', title: 'Second', file: 'src/bar.ts', description: 'Do bar', dependsOn: [t1.id], implementationSteps: ['step 2'], tests: ['test B'] });
    const parsed = parseTasks(formatTasks([t1, t2]));
    expect(parsed[1]?.dependsOn).toContain(t1.id);
  });

  it.each([
    ['implementationSteps', { implementationSteps: ['first step', 'second step'], tests: ['test'] }, (p: Task) => expect(p.implementationSteps).toEqual(['first step', 'second step'])],
    ['tests', { implementationSteps: ['step'], tests: ['assertion one', 'assertion two'] }, (p: Task) => expect(p.tests).toEqual(['assertion one', 'assertion two'])],
    ['constraints', { implementationSteps: ['step'], tests: ['test'], constraints: ['no side effects', 'pure function'] }, (p: Task) => expect(p.constraints).toEqual(['no side effects', 'pure function'])],
    ['escalation', { implementationSteps: ['step'], tests: ['test'], escalation: ['stop on ambiguity'] }, (p: Task) => expect(p.escalation).toEqual(['stop on ambiguity'])],
    ['evidence', { implementationSteps: ['step'], tests: ['test'], evidence: ['npm test passes'] }, (p: Task) => expect(p.evidence).toEqual(['npm test passes'])],
    ['scope', { implementationSteps: ['step'], tests: ['test'], scope: { inBounds: ['only foo.ts'], outOfBounds: ['do not touch bar.ts'] } }, (p: Task) => { expect(p.scope?.inBounds).toEqual(['only foo.ts']); expect(p.scope?.outOfBounds).toEqual(['do not touch bar.ts']); }],
    ['typeDefs', { implementationSteps: ['step'], tests: ['test'], typeDefs: 'export type Foo = { bar: string };' }, (p: Task) => expect(p.typeDefs).toBe('export type Foo = { bar: string };')],
    ['description', { description: 'Implement the helper function for string trimming.', implementationSteps: ['step'], tests: ['test'] }, (p: Task) => expect(p.description).toBe('Implement the helper function for string trimming.')],
    ['signature', { signature: 'export function greet(name: string): string' }, (p: Task) => expect(p.signature).toBe('export function greet(name: string): string')],
    ['currentCode', { action: 'modify' as const, currentCode: 'export function old(): void {}' }, (p: Task) => expect(p.currentCode).toBe('export function old(): void {}')],
    ['pattern', { pattern: 'Follow the existing parseConfig(raw) guard shape.' }, (p: Task) => expect(p.pattern).toBe('Follow the existing parseConfig(raw) guard shape.')],
  ] as [string, Partial<Task>, (p: Task) => void][])('%s round-trips', (_field, overrides, verify) => {
    const task = makeTask(overrides);
    const parsed = parseTasks(formatTasks([task]));
    verify(parsed[0]!);
  });
});
