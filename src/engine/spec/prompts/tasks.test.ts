import { describe, it, expect } from 'vitest';

import { buildLanguageContext } from './language-context.js';
import { briefContract, criticalRules } from './tasks.js';

describe('briefContract', () => {
  const contract = briefContract(buildLanguageContext('typescript'));

  it('forbids planning for a red gate and names the three ways out', () => {
    expect(contract).toContain('leave typecheck, lint and tests green on its own');
    expect(contract).toContain('widen');
    expect(contract).toContain('backward compatible');
    expect(contract).toContain('split');
  });

  it('makes a brief that removes an export name its consumers across src/ and testing/', () => {
    expect(contract).toContain('`src/` and `testing/` alike');
    expect(contract).toContain('colocated and sibling tests included');
  });

  it('names the plan task fields each section renders, with no workflow mode', () => {
    expect(contract).toContain("from the task's `exclusions`. REQUIRED.");
    expect(contract).toContain(
      "one `### Read-only context (do not modify) — <path>` section with the current code of each of the task's `contextFiles`",
    );
    expect(contract).toContain("the task's `intent`");
    expect(contract).toContain(
      "the task's `protectedOperations` as protected writes the user confirms",
    );
    expect(contract).not.toContain('standard mode');
  });

  it('keeps the nine numbered sections ahead of the rule', () => {
    expect(contract).toContain('1. **Identity**');
    expect(contract).toContain('9. **Evidence**');
    expect(contract.indexOf('9. **Evidence**')).toBeLessThan(
      contract.indexOf('Every brief must also leave typecheck'),
    );
  });
});

describe('the planner gives gates to SPLITBRIEF and treats scope as guidance', () => {
  const ctx = buildLanguageContext(undefined);
  const prompt = `${briefContract(ctx)}\n${criticalRules(ctx)}`;

  it.each([
    "Name the test files and cases only: the implementer writes or changes the test files among the brief's files, and SPLITBRIEF runs typecheck, lint and the affected tests after every brief. Never tell the implementer to run a test, typecheck, lint, format, screenshot or render command.",
    "(the focused tests that pass, the changed files, the behavior a reviewer can check). Renders and gate runs are the review seat's and SPLITBRIEF's evidence, not the implementer's steps.",
    '`files` are the suggested files; **Out of bounds** lists the explicit exclusions the reviewer checks.',
  ])('says %j once', (sentence) => {
    expect(prompt.split(sentence)).toHaveLength(2);
  });

  it('drops the scope fence and the gate-running evidence', () => {
    expect(prompt).not.toContain('so the implementer cannot drift into adjacent files');
    expect(prompt).not.toContain('a project-wide gate, the whole suite');
    expect(prompt).not.toContain(
      '(passing tests, validation output, changed files, behavioral note)',
    );
  });
});
