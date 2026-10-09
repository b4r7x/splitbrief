import { describe, expect, it } from 'vitest';
import { makeTask } from '#testing/helpers/factories/task.js';
import { fixBriefDescription, fixReviewChecks } from './fix-task.js';

describe('fixBriefDescription', () => {
  it('prints each carried command with its check id', () => {
    const description = fixBriefDescription('Fix the checks', [
      {
        id: 'F1',
        text: 'Both checks failed',
        acceptance: null,
        checkIds: ['V1', 'V2'],
        commands: { V1: 'tsc --noEmit', V2: 'npm test' },
      },
    ]);

    expect(description).toContain('Command V1: tsc --noEmit\nCommand V2: npm test');
  });

  it('fences a failing output with more backticks than any run inside it', () => {
    const output = 'expected:\n```ts\nhello()\n```\nreceived: ````';
    const description = fixBriefDescription('Fix the greeting', [
      { id: 'P1', text: 'The test failed', acceptance: null, output },
    ]);

    const fence = '`'.repeat(5);
    expect(description).toContain(`Failing output:\n${fence}\n${output}\n${fence}`);
  });
});

describe('fixReviewChecks', () => {
  it('returns no reviewer check when a finding carries no commands', () => {
    const task = makeTask({
      fix: {
        cycle: 1,
        findings: [{ id: 'F1', text: 'A check failed', acceptance: null, checkIds: ['V1'] }],
      },
    });

    expect(fixReviewChecks(task)).toEqual([]);
  });

  it('leaves a plan check to the plan registry', () => {
    const task = makeTask({
      fix: {
        cycle: 1,
        findings: [
          {
            id: 'F1',
            text: 'A plan check failed',
            acceptance: null,
            checkIds: ['K1'],
            commands: { K1: 'npm test' },
          },
        ],
      },
    });

    expect(fixReviewChecks(task)).toEqual([]);
  });

  it('collects both findings and keeps the first command for a repeated id', () => {
    const task = makeTask({
      fix: {
        cycle: 1,
        findings: [
          {
            id: 'F1',
            text: 'The type check failed',
            acceptance: null,
            checkIds: ['V1'],
            commands: { V1: 'tsc --noEmit' },
          },
          {
            id: 'F2',
            text: 'The tests failed',
            acceptance: null,
            checkIds: ['V1', 'V2', 'V3'],
            commands: { V1: 'node --version', V2: 'npm test' },
          },
        ],
      },
    });

    expect(fixReviewChecks(task)).toEqual([
      { id: 'V1', kind: 'cmd', value: 'tsc --noEmit', required: true },
      { id: 'V2', kind: 'cmd', value: 'npm test', required: true },
    ]);
  });
});
