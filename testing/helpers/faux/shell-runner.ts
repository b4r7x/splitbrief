import type { Config } from '../../../src/core/schemas/config.js';
import { makeConfig } from '../factories/config.js';

export const TASK_MARKDOWN = [
  '---',
  'id: T001',
  'title: Create hello module',
  'action: create',
  'file: src/hello.ts',
  '---',
  '',
  '### Description',
  'Create a hello world module',
  '',
  '### Tests',
  '',
  '- returns expected greeting',
  '',
  '### Scope',
  '',
  '**In bounds:**',
  '- src/hello.ts',
  '',
  '**Out of bounds:**',
  '- unrelated files',
  '',
  '### Evidence',
  '',
  '- hello module exists and exports the expected greeting',
  '',
  '### Implementation Steps',
  '',
  '1. Implement the module',
].join('\n');

export const CODE_RESPONSE = [
  '```typescript',
  'export function hello() { return "hello"; }',
  '```',
].join('\n');

// The review seat's answer when the planner holds it: one verdict word under
// `### Verdict`, so the final review parses instead of halting the run.
export const REVIEW_MARKDOWN = [
  '# Final review',
  '',
  '### Verdict',
  'pass',
  '',
  '### Criteria Results',
  '- **[PASS]** Task brief satisfied -- the module exports the expected greeting.',
  '',
  '### Findings',
  '',
  '### Summary',
  'The implementation matches the brief.',
].join('\n');

// The shell planner answers from stdin: planning calls get the brief markdown,
// the final review (its prompt is titled "Final Implementation Review") gets a
// verdict. A static echo cannot hold the review seat.
export function shellPlannerArgs(): string[] {
  const script = [
    "let prompt = '';",
    "try { prompt = require('node:fs').readFileSync(0, 'utf-8'); } catch {}",
    `const review = ${JSON.stringify(`${REVIEW_MARKDOWN}\n`)};`,
    `const tasks = ${JSON.stringify(`${TASK_MARKDOWN}\n`)};`,
    "process.stdout.write(prompt.includes('Final Implementation Review') ? review : tasks);",
  ].join('\n');
  return ['-e', script];
}

export function makeShellRunnerConfig(overrides?: Parameters<typeof makeConfig>[0]): Config {
  return makeConfig({
    planner: {
      kind: 'shell',
      command: 'node',
      args: shellPlannerArgs(),
    },
    implementer: {
      kind: 'shell',
      command: 'node',
      args: ['-e', `process.stdout.write(${JSON.stringify(CODE_RESPONSE)})`],
      model: 'fake-model',
      contextLength: 4096,
      temperature: 0,
    },
    ...overrides,
    validation: {
      typecheck: false,
      lint: false,
      test: false,
      testCommand: 'noop',
      ...overrides?.validation,
    },
    workflow: {
      mode: 'quick',
      maxRetries: 1,
      ...overrides?.workflow,
    },
  });
}
