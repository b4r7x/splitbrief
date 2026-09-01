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

export function makeShellRunnerConfig(overrides?: Parameters<typeof makeConfig>[0]): Config {
  return makeConfig({
    planner: {
      kind: 'shell',
      command: 'node',
      args: ['-e', `process.stdout.write(${JSON.stringify(TASK_MARKDOWN)})`],
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
      persistTranscript: false,
      maxRetries: 1,
      ...overrides?.workflow,
    },
  });
}
