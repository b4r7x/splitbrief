import { describe, expect, it } from 'vitest';
import { makePlanProposal } from '#testing/helpers/factories/plan.js';
import { PLAN_ANSWER_JSON_SCHEMA } from '../../../core/schemas/plan.js';
import { buildLanguageContext } from './language-context.js';
import {
  buildPlanSessionPrompt,
  planAnswersTurn,
  planHistory,
  planRepairTurn,
  planRevisedTurn,
} from './plan-session.js';

const input = {
  feature: 'Greet people by name',
  projectContext: 'repo facts',
  languageContext: buildLanguageContext('typescript'),
  build: { model: 'deepseek-v4.1-flash', contextTokens: 128000 },
  approvesPlan: true,
};

describe('buildPlanSessionPrompt', () => {
  it('asks for files instead of code and names the context files the implementer receives', () => {
    const prompt = buildPlanSessionPrompt(input);
    expect(prompt).toContain('Do not copy code into a task');
    expect(prompt).toContain('`contextFiles`');
  });

  it('forbids a task to depend on anything outside its fields and the plan context', () => {
    const prompt = buildPlanSessionPrompt(input);
    expect(prompt).toContain(
      "A task must not depend on anything outside its own fields and the plan context (summary, decisions, its criteria); do not refer to 'the plan' or to another task's text.",
    );
  });

  it('sizes the tasks for the BUILD model and its measured context', () => {
    const prompt = buildPlanSessionPrompt(input);
    expect(prompt).toContain('deepseek-v4.1-flash');
    expect(prompt).toContain('128,000 tokens');
  });

  it('names the configured implementer when its model has no catalog id', () => {
    const prompt = buildPlanSessionPrompt({
      ...input,
      build: { model: undefined, contextTokens: 32768 },
    });
    expect(prompt).toContain('the configured implementer');
    expect(prompt).toContain('32,768 tokens');
  });

  it('asks for every protected write as a protected operation', () => {
    const prompt = buildPlanSessionPrompt(input);
    expect(prompt).toContain('`protectedOperations`');
    expect(prompt).toContain('dependency manifests and lockfiles');
  });

  it('sizes a task as one behaviour with its tests and callers, split only for context fit', () => {
    const prompt = buildPlanSessionPrompt(input);
    expect(prompt).toContain(
      'Each task completes one verifiable behaviour, including its tests and the caller changes it needs.',
    );
    expect(prompt).toContain(
      '`intent` names the behaviour and its expected result, never only files.',
    );
    expect(prompt).toContain('Never separate implement, test and caller tasks for one behaviour.');
    expect(prompt).toContain(
      "Split a behaviour only when its task would not fit the implementer's context, and split it into behaviours that each verify on their own.",
    );
  });

  it('offers a package script check only when the run approves its plan', () => {
    expect(buildPlanSessionPrompt(input)).toContain(
      'A `cmd` check runs `npm run <script>` only for a script `package.json` defines; the plan approval confirms it.',
    );
    const unapproved = buildPlanSessionPrompt({ ...input, approvesPlan: false });
    expect(unapproved).toContain(
      'This run approves no plan, so SPLITBRIEF refuses a `cmd` check that runs a package script (`npm run <script>`): a package manager runs only as its bare `test` command.',
    );
    expect(unapproved).not.toContain('the plan approval confirms it');
  });

  it('keeps a task check fast and the full gate in the run checks', () => {
    const prompt = buildPlanSessionPrompt(input);
    expect(prompt).toContain(
      "SPLITBRIEF runs a task's own checks after the task, and every required check before every review. The reviewer chooses the commands that verify the change. A task check is the fastest command that proves the task: its test file, the typecheck or a lint. Put the full gate, such as a release or CI script, in the run checks, never in a task. A `render` check is slow and runs before a review.",
    );
    expect(prompt).not.toContain('`batch`: 1, 2, …. SPLITBRIEF runs');
  });

  it('explains that a test check runs the discovered command on its file', () => {
    expect(buildPlanSessionPrompt(input)).toContain(
      'A `test` check runs that command on its file.',
    );
  });

  it('names the cmd check that runs one test file when a chained test script runs whole', () => {
    const prompt = buildPlanSessionPrompt(input);
    expect(prompt).toContain(
      'A `test` check narrows `npm test` to its file (`npm test -- <file>`) only when the `package.json` test script is one command.',
    );
    expect(prompt).toContain(
      "use a `cmd` check that runs the project's test runner on the file directly: `node --test <test file>`, `npx --no-install vitest run <test file>` or `npx --no-install jest <test file>`.",
    );
  });

  it('names the file tests that check a file mode or a symbolic link at every approve level', () => {
    for (const approvesPlan of [true, false]) {
      expect(buildPlanSessionPrompt({ ...input, approvesPlan })).toContain(
        'As a `cmd` check, `test -e <file>`, `test -f <file>`, `test -x <file>` and `test -L <file>` check that a file exists, is a regular file, is executable or is a symbolic link; use them to check a file mode or a symbolic link instead of a new test file.',
      );
    }
  });

  it('asks for the test file pattern as a file name pattern without a directory', () => {
    const prompt = buildPlanSessionPrompt(input);
    expect(prompt).toContain('`testPattern`');
    expect(prompt).toContain('`*.test.js`');
    expect(prompt).toContain('no `/`');
    expect(prompt).toContain('no `..`');
  });

  it('sends the file name pattern rule in the planner typed-output schema', () => {
    const schema = JSON.stringify(PLAN_ANSWER_JSON_SCHEMA);

    expect(schema).toContain('File name pattern with one `*`');
    expect(schema).toContain('`*.test.js`');
    expect(schema).toContain('`test_*.py`');
    expect(schema).toContain('no `/`');
    expect(schema).toContain('no `..`');
    expect(schema).toContain('beside the changed file');
    expect(schema).toContain("in the stack's test folders");
  });

  it('bounds the questions: three per round, two rounds, each with a default', () => {
    const prompt = buildPlanSessionPrompt(input);
    expect(prompt).toContain('at most 3 questions');
    expect(prompt).toContain('at most 2 rounds');
    expect(prompt).toContain('`default`');
  });

  it('carries the request, the repository map and the documents of an earlier planning chain', () => {
    const prompt = buildPlanSessionPrompt({
      ...input,
      codebaseContext: 'src/hello.ts: greet()',
      earlierPlanning: '### research.md\nOld findings',
    });
    expect(prompt).toContain('Greet people by name');
    expect(prompt).toContain('src/hello.ts: greet()');
    expect(prompt).toContain('Old findings');
  });

  it('carries the run skills after the project context', () => {
    const prompt = buildPlanSessionPrompt({
      ...input,
      skillsContext: '## Active Project Skills\n\nSKILL-BODY',
    });
    expect(prompt).toContain('## Project Context\nrepo facts\n\n## Active Project Skills');
  });
});

describe('the planning session turns', () => {
  it('hands the planner the user answers', () => {
    const turn = planAnswersTurn('1. Which module?\nsrc/hello.ts', 1);
    expect(turn).toContain('1. Which module?\nsrc/hello.ts');
    expect(turn).not.toContain('No question round remains');
    expect(planAnswersTurn('1. Which style?\nterse', 2)).toContain('No question round remains');
  });

  it('lists every failed check, and carries the failed plan only when the planner holds no session', () => {
    const errors = [
      { code: 'uncovered-criterion' as const, message: 'Criterion C2 is served by no task.' },
    ];
    const plan = makePlanProposal();
    expect(planRepairTurn(errors)).toContain(
      '- uncovered-criterion: Criterion C2 is served by no task.',
    );
    expect(planRepairTurn(errors)).not.toContain('"summary"');
    expect(planRepairTurn(errors, plan)).toContain('"summary": "Greet people by name"');
  });

  it('replays the answered rounds for a planner that holds no session', () => {
    expect(planHistory([])).toBe('');
    expect(planHistory([{ reply: 'Which module?', answer: 'src/hello.ts' }])).toContain(
      'Planner:\nWhich module?\n\nUser:\nsrc/hello.ts',
    );
  });

  it('hands the planner the correction and the plan the user reviewed', () => {
    const turn = planRevisedTurn(JSON.stringify(makePlanProposal(), null, 2), 'Greet in Polish');
    expect(turn).toContain('Greet in Polish');
    expect(turn).toContain('"summary": "Greet people by name"');
  });

  it('names no reviewed plan for an older run that never wrote plan.json', () => {
    const turn = planRevisedTurn('', 'Greet in Polish');
    expect(turn).toContain('Greet in Polish');
    expect(turn).not.toContain('The plan they reviewed');
  });
});
