import { describe, it, expect } from 'vitest';
import {
  formatTaskPrompt,
  formatRetryPrompt,
  formatImplementerSystemPreamble,
} from './prompt-formatter.js';
import { buildLanguageContext } from './prompts/language-context.js';
import { estimateTokens } from '../../core/tokens/estimate.js';
import { makeTask as makeBaseTask } from '#testing/helpers/factories/task.js';
import { defaultContext } from '#testing/helpers/factories/config.js';
import { taskId, type Task } from '../../core/schemas/task.js';

const context = defaultContext;

type TaskOverrides = Omit<Partial<Task>, 'id' | 'dependsOn'> & {
  id?: string;
  dependsOn?: string[];
};

function makeTask(overrides: TaskOverrides = {}): Task {
  return makeBaseTask({
    title: 'Create utility module',
    suggestedFiles: ['src/utils/helpers.ts'],
    description: 'Implement helper functions for string manipulation.',
    ...overrides,
  });
}

describe('formatTaskPrompt', () => {
  it('presents the Tests section as the tests SPLITBRIEF runs after the hand-back', () => {
    const prompt = formatTaskPrompt({
      task: makeTask({ tests: ['greet("Ada") returns "Hello, Ada"'] }),
      context,
      writesFiles: 'direct',
    });
    const lines = prompt.split('\n');
    const at = lines.indexOf('### Tests');

    expect(lines.slice(at + 1, at + 4)).toEqual([
      'SPLITBRIEF runs these tests after you hand back. Write or change the ones in the files this brief lists.',
      '- greet("Ada") returns "Hello, Ada"',
      '',
    ]);
  });

  it('limits the test files an extracted-code writer writes to its one file', () => {
    const prompt = formatTaskPrompt({
      task: makeTask({ tests: ['greet("Ada") returns "Hello, Ada"'] }),
      context,
      writesFiles: 'extracted-code',
    });
    const lines = prompt.trimEnd().split('\n');

    expect(lines).toContain(
      'SPLITBRIEF runs these tests after you hand back. Write or change the ones in the files this brief lists.',
    );
    expect(lines.at(-1)).toBe(
      'Output the complete file contents for src/utils/helpers.ts. No markdown fences. No explanations.',
    );
  });

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

  it('renders every declared file and current code per file', () => {
    const task = makeTask({
      action: 'modify',
      suggestedFiles: ['src/x.ts', 'src/x.test.ts'],
      currentCode: 'export function x(): void {}\n',
      currentCodeByFile: { 'src/x.test.ts': "it('x', () => {});\n" },
    });
    const prompt = formatTaskPrompt({ task, context });

    expect(prompt).toContain('### Files:');
    expect(prompt).toContain('- src/x.ts (anchor)');
    expect(prompt).toContain('- src/x.test.ts');
    expect(prompt).not.toContain('### File: ');
    expect(prompt).toContain('### Current Code — src/x.test.ts');
    expect(prompt).toContain("it('x', () => {});");
  });

  it('one-file brief still renders ### File:', () => {
    const prompt = formatTaskPrompt({ task: makeTask(), context });
    expect(prompt).toContain('### File: src/utils/helpers.ts');
    expect(prompt).not.toContain('### Files:');
  });

  it('keeps a five-file slice inside the context window', () => {
    const contextLength = 8192;
    const body = (name: string) =>
      `export function ${name}(): void {}\n${'// filler\n'.repeat(2000)}`;
    const task = makeTask({
      action: 'modify',
      suggestedFiles: ['src/a.ts', 'src/b.ts', 'src/c.ts', 'src/d.ts', 'src/e.ts'],
      currentCode: body('a'),
      currentCodeByFile: {
        'src/b.ts': body('b'),
        'src/c.ts': body('c'),
        'src/d.ts': body('d'),
        'src/e.ts': body('e'),
      },
    });

    const prompt = formatTaskPrompt({ task, context, contextLength });

    expect(estimateTokens(prompt)).toBeLessThan(contextLength);
    expect(prompt.split('### Current Code').length - 1).toBe(5);
  });

  it('renders sibling code for a create anchor whose sibling already exists', () => {
    const task = makeTask({
      action: 'create',
      suggestedFiles: ['src/health.ts', 'src/health.test.ts'],
      currentCodeByFile: { 'src/health.test.ts': "it('health', () => {});\n" },
    });

    const prompt = formatTaskPrompt({ task, context });
    expect(prompt).toContain('### Current Code — src/health.test.ts');
    expect(prompt).toContain("it('health', () => {});");

    const retry = formatRetryPrompt({ task, context, error: 'boom', attempt: 1 });
    expect(retry).toContain('### Current Code — src/health.test.ts');
  });

  it('renders the anchor code for a create anchor the workspace already holds, and none for a new one', () => {
    const held = makeTask({
      action: 'create',
      suggestedFiles: ['src/calc.mjs'],
      currentCode: 'export const add = (a, b) => a + b;\n',
    });

    for (const prompt of [
      formatTaskPrompt({ task: held, context, outputContract: 'legacy-code-v1' }),
      formatTaskPrompt({ task: held, context, contextLength: 8192 }),
    ]) {
      expect(prompt).toContain('### Current Code');
      expect(prompt).toContain('export const add = (a, b) => a + b;');
    }

    const fresh = makeTask({ action: 'create', suggestedFiles: ['src/calc.mjs'] });
    expect(
      formatTaskPrompt({ task: fresh, context, outputContract: 'legacy-code-v1' }),
    ).not.toContain('### Current Code');
  });

  it('carries context files whole under a read-only heading, for a new file and a bundle', () => {
    const task = makeTask({
      action: 'create',
      suggestedFiles: ['src/health.ts'],
      contextFiles: ['src/types.ts'],
      contextCodeByFile: { 'src/types.ts': 'export type Health = "ok";\n' },
    });

    for (const prompt of [
      formatTaskPrompt({ task, context, contextLength: 8192 }),
      formatTaskPrompt({ task, context, outputContract: 'file-bundle-v1' }),
      formatRetryPrompt({ task, context, error: 'boom', attempt: 1, contextLength: 8192 }),
    ]) {
      expect(prompt).toContain('### Read-only context (do not modify) — src/types.ts');
      expect(prompt).toContain('export type Health = "ok";');
      expect(prompt).not.toContain('### Current Code');
    }
  });

  it('leaves room for the context code when it truncates the target code', () => {
    const contextLength = 32768;
    const task = makeTask({
      action: 'modify',
      currentCode: 'export const big = 1;\n'.repeat(17_000),
      contextFiles: ['src/types.ts'],
      contextCodeByFile: { 'src/types.ts': 'export type Health = "ok";\n'.repeat(1_400) },
    });
    const system = formatImplementerSystemPreamble(
      buildLanguageContext(undefined),
      'extracted-code',
      context.dir,
    );

    for (const prompt of [
      formatTaskPrompt({ task, context, contextLength }),
      formatRetryPrompt({ task, context, error: 'boom', attempt: 1, contextLength }),
    ]) {
      expect(prompt).toContain('### Read-only context (do not modify) — src/types.ts');
      expect(estimateTokens(prompt) + estimateTokens(system)).toBeLessThanOrEqual(contextLength);
    }
  });

  it('keeps the target code when a context file alone would fill the budget', () => {
    const contextLength = 12_000;
    const task = makeTask({
      action: 'modify',
      currentCode: 'export const anchor = 1;\n',
      contextFiles: ['src/big.ts'],
      contextCodeByFile: { 'src/big.ts': 'x'.repeat(36_000) },
    });
    const system = formatImplementerSystemPreamble(
      buildLanguageContext(undefined),
      'extracted-code',
      context.dir,
    );

    for (const prompt of [
      formatTaskPrompt({ task, context, contextLength }),
      formatRetryPrompt({ task, context, error: 'boom', attempt: 1, contextLength }),
    ]) {
      expect(prompt).toContain('export const anchor = 1;');
      expect(prompt).toContain('### Read-only context (do not modify) — src/big.ts');
      expect(estimateTokens(prompt) + estimateTokens(system)).toBeLessThanOrEqual(contextLength);
    }
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

describe('direct writer', () => {
  const task = makeTask({
    action: 'modify',
    suggestedFiles: ['src/x.ts', 'src/x.test.ts'],
    currentCode: 'export function x(): void {}\n',
    currentCodeByFile: { 'src/x.test.ts': "it('x', () => {});\n" },
    contextCodeByFile: { 'src/y.ts': 'export const y = 1;\n' },
  });

  it('task prompt carries the context code but not the code of the files it edits', () => {
    const prompt = formatTaskPrompt({ task, context, contextLength: 8192, writesFiles: 'direct' });

    expect(prompt).not.toContain('Current Code');
    expect(prompt).not.toContain('export function x(): void {}');
    expect(prompt).not.toContain("it('x', () => {});");
    expect(prompt).toContain(
      '### Read-only context (do not modify) — src/y.ts\nexport const y = 1;',
    );
    expect(prompt).toContain('- src/x.ts (anchor)');
    expect(prompt).toContain('Edit src/x.ts, src/x.test.ts directly in the isolation directory');
  });

  it('an in-place task and retry prompt name the checkout instead of the isolation directory', () => {
    const prompt = formatTaskPrompt({ task, context, writesFiles: 'direct', inPlace: true });
    const retry = formatRetryPrompt({
      task,
      context,
      error: 'boom',
      attempt: 1,
      writesFiles: 'direct',
      inPlace: true,
    });
    for (const text of [prompt, retry]) {
      expect(text).toContain("Edit src/x.ts, src/x.test.ts directly in the user's checkout");
      expect(text).not.toContain('isolation directory');
    }
  });

  it('retry prompt carries the context code and no current code either', () => {
    const retry = formatRetryPrompt({
      task,
      context,
      error: 'boom',
      attempt: 2,
      contextLength: 8192,
      writesFiles: 'direct',
    });

    expect(retry).toContain('boom');
    expect(retry).not.toContain('Current Code');
    expect(retry).not.toContain('export function x(): void {}');
    expect(retry).not.toContain("it('x', () => {});");
    expect(retry).toContain('### Read-only context (do not modify) — src/y.ts');
    expect(retry).toContain('rephrased');
  });

  it('an extracted-code writer still gets every file body', () => {
    const prompt = formatTaskPrompt({ task, context, writesFiles: 'extracted-code' });

    expect(prompt).toContain('### Current Code\nexport function x(): void {}');
    expect(prompt).toContain('### Current Code — src/x.test.ts');
  });

  it('the file-bundle contract still gets every file body', () => {
    const prompt = formatTaskPrompt({
      task,
      context,
      writesFiles: 'extracted-code',
      outputContract: 'file-bundle-v1',
    });
    const retry = formatRetryPrompt({
      task,
      context,
      error: 'boom',
      attempt: 1,
      writesFiles: 'extracted-code',
      outputContract: 'file-bundle-v1',
    });

    expect(prompt).toContain('### Current Code\nexport function x(): void {}');
    expect(prompt).toContain('### Current Code — src/x.test.ts');
    expect(retry).toContain('### Current Code — src/x.test.ts');
  });

  it('the file-bundle contract with direct writer still gets every file body', () => {
    const prompt = formatTaskPrompt({
      task,
      context,
      writesFiles: 'direct',
      outputContract: 'file-bundle-v1',
    });

    expect(prompt).toContain('### Current Code\nexport function x(): void {}');
    expect(prompt).toContain('### Current Code — src/x.test.ts');
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
    expect(prompt).toContain(task.suggestedFiles[0]);
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

describe('plan context', () => {
  const plan = {
    summary: 'Bound the pipeline with named constants.',
    decisions: [
      { text: 'MAX_ROUNDS is 2 and lives in src/core/pipeline-spec/bounds.ts.', taskId: null },
    ],
    criteria: [
      { id: 'C1', text: 'The bounds module exports MAX_ROUNDS.', checkIds: ['K1'] },
      { id: 'C2', text: 'The review screen shows the round count.', checkIds: ['K2'] },
    ],
  };

  it('carries the decision a task intent names, and only the criteria the task serves', () => {
    const task = makeTask({
      description: 'New bounds module with the constants named in the plan decisions.',
      criteria: ['C1'],
    });
    const prompt = formatTaskPrompt({ task, context, plan });

    expect(prompt).toContain('Plan context');
    expect(prompt).toContain(plan.summary);
    expect(prompt).toContain('MAX_ROUNDS is 2 and lives in src/core/pipeline-spec/bounds.ts.');
    expect(prompt).toContain('The bounds module exports MAX_ROUNDS.');
    expect(prompt).not.toContain('The review screen shows the round count.');
  });

  it('gives a task with no matching criteria the summary and decisions only', () => {
    const task = makeTask({ criteria: ['C9'] });
    const prompt = formatTaskPrompt({ task, context, plan });

    expect(prompt).toContain(plan.summary);
    expect(prompt).toContain('MAX_ROUNDS is 2');
    expect(prompt).not.toContain('The bounds module exports MAX_ROUNDS.');
    expect(prompt).not.toContain('The review screen shows the round count.');
  });

  it('reads task, then plan context, then code', () => {
    const task = makeTask({
      action: 'modify',
      currentCode: 'export const OLD = 1;\n',
      criteria: ['C1'],
    });
    const prompt = formatTaskPrompt({ task, context, plan });

    const description = prompt.indexOf(task.description);
    const planContext = prompt.indexOf('Plan context');
    const code = prompt.indexOf('export const OLD = 1;');
    expect(description).toBeGreaterThan(-1);
    expect(planContext).toBeGreaterThan(description);
    expect(code).toBeGreaterThan(planContext);
  });

  it('carries the same section in a retry prompt', () => {
    const task = makeTask({ criteria: ['C2'] });
    const prompt = formatRetryPrompt({ task, context, error: 'tests failed', attempt: 2, plan });

    expect(prompt).toContain('Plan context');
    expect(prompt).toContain(plan.summary);
    expect(prompt).toContain('MAX_ROUNDS is 2');
    expect(prompt).toContain('The review screen shows the round count.');
    expect(prompt).not.toContain('The bounds module exports MAX_ROUNDS.');
  });

  it('shows a confirmed decision with the task that reported it', () => {
    const task = makeTask({ criteria: ['C1'] });
    const prompt = formatTaskPrompt({
      task,
      context,
      plan: {
        ...plan,
        decisions: [{ text: 'Use node:crypto', taskId: taskId('T003') }],
      },
    });

    expect(prompt).toContain('- Use node:crypto (T003)');
  });

  it('says the implementation steps are guidance', () => {
    const task = makeTask({ implementationSteps: ['Create the module', 'Wire the export'] });
    const prompt = formatTaskPrompt({ task, context });

    expect(prompt).toContain('Guidance only: another approach that passes the checks is fine.');
    expect(prompt).toContain('1. Create the module');
  });
});
