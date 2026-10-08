import { describe, expect, it } from 'vitest';
import { buildReviewChecksPrompt, type ReviewChecksPromptInput } from './review-checks.js';

function prompt(overrides: Partial<ReviewChecksPromptInput> = {}): string {
  return buildReviewChecksPrompt({
    scope: 'final',
    taskIds: ['T001', 'T002'],
    changedFiles: ['src/a.ts', 'src/a.test.ts'],
    npmScriptsApproved: true,
    programs: ['cargo', 'npm', 'pytest'],
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

  it('names the programs the command policy starts', () => {
    expect(prompt()).toContain('starts only these programs: `cargo`, `npm`, `pytest`.');
  });

  it('admits package scripts only when the plan approved them', () => {
    expect(prompt()).toContain('A package script runs as `npm run <script>`');
    const refused = prompt({ npmScriptsApproved: false });
    expect(refused).toContain('Package scripts (`npm run <script>`) are refused in this run');
    expect(refused).not.toContain('A package script runs as `npm run <script>`');
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
