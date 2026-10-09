import { describe, expect, it } from 'vitest';
import { REVIEWER_COMMAND_RULES } from '../../orchestrator/validation/reviewer-command-policy.js';
import { buildReviewChecksPrompt, type ReviewChecksPromptInput } from './review-checks.js';

function prompt(overrides: Partial<ReviewChecksPromptInput> = {}): string {
  return buildReviewChecksPrompt({
    scope: 'final',
    taskIds: ['T001', 'T002'],
    changedFiles: ['src/a.ts', 'src/a.test.ts'],
    workspaceInstructions: 'The run workspace is `/ws`.',
    ...overrides,
  });
}

describe('buildReviewChecksPrompt', () => {
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
