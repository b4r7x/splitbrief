import { describe, expect, it } from 'vitest';
import { makePlanProposal, makeTaskSpec } from '#testing/helpers/factories/plan.js';
import { formatPlanMarkdown } from './plan-markdown.js';

describe('formatPlanMarkdown', () => {
  it('renders the summary, decisions, criteria, run checks, batches and protected operations', () => {
    const plan = makePlanProposal({
      checks: [{ id: 'K9', kind: 'cmd', value: 'npm test', required: true }],
      criteria: [{ id: 'C1', text: 'A name gets a greeting', checkIds: ['K1', 'K9'] }],
      tasks: [
        makeTaskSpec({ contextFiles: ['src/names.ts'] }),
        makeTaskSpec({
          id: 'T002',
          title: 'Pin the dependency',
          dependsOn: ['T001'],
          batch: 2,
          suggestedFiles: ['package.json'],
          checks: [{ id: 'K2', kind: 'cmd', value: 'npm ls', required: false }],
          protectedOperations: [{ path: 'package.json', operation: 'write' }],
        }),
      ],
    });

    expect(formatPlanMarkdown(plan)).toBe(
      [
        'Greet people by name',
        '',
        '## Protected operations',
        '',
        '- T002: write package.json',
        '',
        '## Decisions',
        '',
        '- Keep the greeting in one module',
        '',
        '## Criteria',
        '',
        '- C1: A name gets a greeting (checks: K1, K9)',
        '',
        '## Run checks',
        '',
        '- K9 cmd: npm test',
        '',
        '## Tasks',
        '',
        '### Batch 1',
        '',
        '#### T001 Add the greeting',
        '',
        'Return a greeting for a name',
        '',
        '- Criteria: C1',
        '- Checks: K1 test: src/hello.test.ts',
        '- Suggested files: src/hello.ts',
        '- Context files: src/names.ts',
        '',
        '### Batch 2',
        '',
        '#### T002 Pin the dependency',
        '',
        'Return a greeting for a name',
        '',
        '- Criteria: C1',
        '- Checks: K2 cmd (optional): npm ls',
        '- Suggested files: package.json',
        '- Depends on: T001',
        '',
      ].join('\n'),
    );
  });
});
