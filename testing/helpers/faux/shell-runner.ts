import type { Config } from '../../../src/core/schemas/config.js';
import { makeConfig } from '../factories/config.js';

export const CODE_RESPONSE = [
  '```typescript',
  'export function hello() { return "hello"; }',
  '```',
].join('\n');

/** Answers the final review with a typed verdict for the prompt's Required Results ids. */
export function shellPlannerArgs(): string[] {
  const script = [
    "let prompt = '';",
    "try { prompt = require('node:fs').readFileSync(0, 'utf-8'); } catch {}",
    'const ids = (label) => {',
    "  const match = prompt.match(new RegExp('^' + label + ' (.+)$', 'm'));",
    "  const value = match ? match[1].trim() : 'none';",
    "  return value === 'none' || value === '' ? [] : value.split(',').map((id) => id.trim()).filter(Boolean);",
    '};',
    "if (prompt.includes('# Final Implementation Review')) {",
    "  const verdict = { tasks: ids('Task ids:').map((id) => ({ id, plan: 'met', note: '' })), criteria: ids('Criterion ids:').map((id) => ({ id, status: 'pass', evidence: '' })), findings: [], fixTasks: [], rejected: [], verify: [], ask: null };",
    '  process.stdout.write(JSON.stringify(verdict));',
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
      endChecks: false,
      testCommand: 'noop',
      ...overrides?.validation,
    },
  });
}
