import { describe, expect, it } from 'vitest';
import { REVIEWER_COMMAND_RULES } from '../../orchestrator/validation/reviewer-command-policy.js';
import { buildReviewChecksPrompt, type ReviewChecksPromptInput } from './review-checks.js';

function prompt(overrides: Partial<ReviewChecksPromptInput> = {}): string {
  return buildReviewChecksPrompt({
    scope: 'final',
    taskIds: ['T001', 'T002'],
    changedFiles: ['src/a.ts', 'src/a.test.ts'],
    preRunFiles: [],
    requiredCommands: [],
    plan: {
      criteria: [
        { id: 'C1', text: 'Totals match the ledger', checkIds: ['K1'] },
        { id: 'C2', text: 'Reports export as CSV', checkIds: ['K2'] },
      ],
      tasks: [
        {
          id: 'T001',
          lineageId: 'T001',
          status: 'done',
          title: 'Calculate totals',
          intent: 'The reviewer must run npm run check:totals.',
          steps: ['Implement the totals', 'Reviewer: run npm run check:rounding.'],
          criteria: ['C1'],
          suggestedFiles: ['src/total.ts'],
          exclusions: ['Do not change report exports'],
        },
        {
          id: 'T002',
          lineageId: 'T002',
          status: 'pending',
          title: 'Export reports',
          intent: 'The reviewer must run npm run check:exports.',
          steps: ['Reviewer: run npm run check:csv.'],
          criteria: ['C2'],
          suggestedFiles: ['src/export.ts'],
          exclusions: [],
        },
      ],
      decisions: [
        { text: 'Use the project checks without network access', taskId: null },
        { text: 'Check negative totals', taskId: 'T001' },
        { text: 'Keep CSV column order', taskId: 'T002' },
      ],
    },
    workspaceInstructions: 'The run workspace is `/ws`.',
    ...overrides,
  });
}

describe('buildReviewChecksPrompt', () => {
  it('includes every brief and plan decision in a final check choice', () => {
    const text = prompt({ taskIds: [] });

    expect(text).toContain('## Plan');
    expect(text).toContain('### Criteria');
    expect(text).toContain('C1: Totals match the ledger (checks: K1)');
    expect(text).toContain('C2: Reports export as CSV (checks: K2)');
    expect(text).toContain('### Tasks');
    expect(text).toContain(
      'T001 [done] Calculate totals: The reviewer must run npm run check:totals.',
    );
    expect(text).toContain(
      'T002 [pending] Export reports: The reviewer must run npm run check:exports.',
    );
    expect(text).toContain('Suggested files: src/total.ts');
    expect(text).toContain('Exclusions: Do not change report exports');
    expect(text).toContain(
      '  - Steps:\n    1. Implement the totals\n    2. Reviewer: run npm run check:rounding.',
    );
    expect(text).toContain('Reviewer: run npm run check:csv.');
    expect(text).toContain('### Decisions');
    expect(text).toContain('Use the project checks without network access');
    expect(text).toContain('Check negative totals (T001)');
    expect(text).toContain('Keep CSV column order (T002)');
  });

  it('limits a task check choice to its briefs, criteria and applicable decisions', () => {
    const text = prompt({ scope: 'task', taskIds: ['T001'] });

    expect(text).toContain('The reviewer must run npm run check:totals.');
    expect(text).toContain('Reviewer: run npm run check:rounding.');
    expect(text).toContain('C1: Totals match the ledger');
    expect(text).toContain('Use the project checks without network access');
    expect(text).toContain('Check negative totals (T001)');
    expect(text).not.toContain('T002');
    expect(text).not.toContain('Reports export as CSV');
    expect(text).not.toContain('npm run check:exports');
    expect(text).not.toContain('Keep CSV column order');
    expect(text).not.toContain('npm run check:csv');
  });

  it('carries the operator instructions given after a brief was written', () => {
    const text = prompt({
      operatorInstructions: 'T001:\n```\nAlso run npm run check:rounding.\n```',
    });

    expect(text).toContain('## Operator Instructions');
    expect(text).toContain("They are the user's own decisions");
    expect(text).toContain('Also run npm run check:rounding.');
  });

  it('requires pending commands first, even for a task review of the whole suite', () => {
    const text = prompt({ scope: 'task', requiredCommands: ['npm test', 'npm run typecheck'] });

    expect(text).toContain('## Commands a fix check ran\n\n- `npm test`\n- `npm run typecheck`');
    expect(text).toContain(
      'Choose each of them first, as V1, V2, ..., with this exact command text',
    );
    expect(text).toContain('A fix check can pass while the command still shows other failures');
    expect(text).toContain('For these commands, the whole-suite restriction above does not apply.');
    expect(text).toContain('Do not choose the whole suite.');
    expect(prompt()).not.toContain('## Commands a fix check ran');
  });

  it('asks a final review for the project checks, and a task review for the related tests only', () => {
    const final = prompt();
    expect(final).toContain('The review covers every change of this run.');
    expect(final).not.toContain('Do not choose the whole suite.');

    const task = prompt({ scope: 'task' });
    expect(task).toContain('The review covers the changes of T001, T002.');
    expect(task).toContain('Choose the commands that run the tests related to the files below');
    expect(task).toContain('Do not choose the whole suite.');
    expect(task).not.toContain('every change of this run');
  });

  it('lists the changed files, or says none changed', () => {
    expect(prompt()).toContain('## Changed files\n\n- src/a.ts\n- src/a.test.ts');
    expect(prompt({ changedFiles: [] })).toContain('## Changed files\n\nNo file changed.');
  });

  it("names the files changed before the run as the user's own work, apart from the run's", () => {
    expect(prompt()).not.toContain('## Changed before this run');
    const text = prompt({ preRunFiles: ['package.json', 'scripts/check.mjs'] });
    expect(text).toContain(
      '## Changed files\n\n- src/a.ts\n- src/a.test.ts\n\n## Changed before this run',
    );
    expect(text).toContain(
      "the user's own work, not changes of this run: the run base holds them, and the command policy compares with the run base.\n- package.json\n- scripts/check.mjs",
    );
  });

  it('admits any installed program and states every rule of the reviewer command policy', () => {
    const text = prompt();
    expect(text).toContain("Any installed program of the project's stack can run");
    for (const rule of REVIEWER_COMMAND_RULES) expect(text).toContain(`  - ${rule}`);
    expect(text).toContain('Reviewer package scripts need no plan approval.');
    expect(text).toContain('checks every reviewer `npm run` script against the run base.');
    expect(text).not.toContain('starts only these programs');
  });

  it('tells a workspace reader where to read, and fences the files of a seat that reads none', () => {
    const reader = prompt();
    expect(reader).toContain('The run workspace is `/ws`.');
    expect(reader).not.toContain('verbatim copies');

    const verbatim = prompt({
      workspaceInstructions: undefined,
      projectFiles: [
        { path: 'package.json', text: '{"scripts":{"test":"vitest run"}}', trimmed: false },
        { path: 'Makefile', text: 'test:\n\t```pytest```', trimmed: true },
      ],
    });
    expect(verbatim).toContain('verbatim copies from the run workspace');
    expect(verbatim).toContain('### package.json\n\n```\n{"scripts":{"test":"vitest run"}}\n```');
    expect(verbatim).toContain('### Makefile (trimmed)\n\n````\ntest:\n\t```pytest```\n````');
    expect(verbatim).not.toContain('### package.json (trimmed)');
  });
});
