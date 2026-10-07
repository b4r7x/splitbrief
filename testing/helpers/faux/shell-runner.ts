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

/**
 * The shell planner answers from stdin: planning calls get the brief markdown,
 * the final review (its prompt is titled "Final Implementation Review") gets a
 * typed review answer built from the prompt's own Required Results ids, so the
 * review clears coverage without a markdown verdict to parse.
 */
export function shellPlannerArgs(): string[] {
  const script = [
    "let prompt = '';",
    "try { prompt = require('node:fs').readFileSync(0, 'utf-8'); } catch {}",
    `const tasks = ${JSON.stringify(`${TASK_MARKDOWN}\n`)};`,
    'const ids = (label) => {',
    "  const match = prompt.match(new RegExp('^' + label + ' (.+)$', 'm'));",
    "  const value = match ? match[1].trim() : 'none';",
    "  return value === 'none' || value === '' ? [] : value.split(',').map((id) => id.trim()).filter(Boolean);",
    '};',
    "if (prompt.includes('# Final Implementation Review')) {",
    "  const verdict = { tasks: ids('Task ids:').map((id) => ({ id, plan: 'met', note: '' })), criteria: ids('Criterion ids:').map((id) => ({ id, status: 'pass', evidence: '' })), findings: [], fixTasks: [], rejected: [], verify: [], ask: null };",
    '  process.stdout.write(JSON.stringify(verdict));',
    '} else {',
    '  process.stdout.write(tasks);',
    '}',
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
      maxRetries: 1,
      ...overrides?.workflow,
    },
  });
}
