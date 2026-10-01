import { describe, it, expect } from 'vitest';
import { buildLanguageContext } from './language-context.js';
import { sliceRuleText } from '../../../core/pipeline-spec/brief.js';
import { buildQuickPlanPrompt } from './quick-plan.js';

describe('buildQuickPlanPrompt', () => {
  it.each([
    'Name the focused test files and cases only. SPLITBRIEF runs typecheck, lint and the affected tests after every brief, so never tell the implementer to run a project-wide gate, the whole suite, or a screenshot/render tool.',
    "(the focused tests that pass, the changed files, the behavior a reviewer can check). Renders and project-wide gates are the review seat's and SPLITBRIEF's evidence, not the implementer's steps.",
    '`files` are the suggested files; **In bounds** is context; **Out of bounds** lists the explicit exclusions the reviewer checks.',
  ])('says %j once', (sentence) => {
    const prompt = buildQuickPlanPrompt({ feature: 'change feature', projectContext: 'repo' });
    expect(prompt.split(sentence)).toHaveLength(2);
    expect(prompt).not.toContain('(passing tests, typecheck, changed files, or equivalent)');
  });

  it('asks the planner to review the codebase for ordinary work', () => {
    const prompt = buildQuickPlanPrompt({ feature: 'change feature', projectContext: 'repo' });
    expect(prompt).toContain('Briefly review the codebase structure and identify files');
    expect(prompt).not.toContain('1-5 briefs max');
  });

  it('carries the active skills section after the project context', () => {
    const prompt = buildQuickPlanPrompt({
      feature: 'change feature',
      projectContext: 'repo',
      skillsContext: '## Active Project Skills\n\n### AuthSkill\nSKILL-BODY',
    });
    expect(prompt).toContain('## Project Context\nrepo\n\n## Active Project Skills');
    expect(prompt).toContain('SKILL-BODY');
  });

  it('tells the planner every brief carries the skills, and says nothing of them without any', () => {
    const rule =
      'Every brief reaches the implementer together with the Active Project Skills section';
    const withSkills = buildQuickPlanPrompt({
      feature: 'change feature',
      projectContext: 'repo',
      skillsContext: '## Active Project Skills\n\n### AuthSkill\nSKILL-BODY',
    });
    expect(withSkills).toContain(rule);
    expect(
      buildQuickPlanPrompt({ feature: 'change feature', projectContext: 'repo' }),
    ).not.toContain(rule);
  });

  it('drops the codebase review and caps the brief count when the work is trivial', () => {
    const prompt = buildQuickPlanPrompt({
      feature: 'rename foo to bar',
      projectContext: 'repo-map: small',
      trivial: true,
    });
    expect(prompt).toContain('This request was auto-classified as a tiny edit');
    expect(prompt).not.toContain('requester');
    expect(prompt).toContain('A single Task Brief is fine; do not over-engineer.');
    expect(prompt).not.toMatch(/briefs max|at most \d+ briefs/);
    expect(prompt).not.toContain('Briefly review the codebase structure');
  });

  it.each([false, true])(
    'keeps every Task Brief contract section in both shapes (trivial: %s)',
    (trivial) => {
      const prompt = buildQuickPlanPrompt({
        feature: 'change feature',
        projectContext: 'repo',
        trivial,
      });
      expect(prompt).toContain(
        'Scope, Implementation Steps, Tests (Validation), Constraints, Escalation, Evidence',
      );
      expect(prompt).toContain('`**In bounds:**` / `**Out of bounds:**`');
      expect(prompt).toContain('must state when the implementer should stop');
      expect(prompt).toContain('must state the reviewable proof');
      expect(prompt).toContain(
        'Outside fenced code blocks, lines containing only `---` are reserved',
      );
      expect(prompt).toContain(
        'Never use a bare `---` as a horizontal rule or phase-heading separator',
      );
    },
  );

  it('groups briefs by outcome and requests no brief, file or line maximum', () => {
    const prompt = buildQuickPlanPrompt({ feature: 'change feature', projectContext: 'repo' });
    expect(prompt).toContain('One brief = one reviewable outcome');
    expect(prompt).toContain(sliceRuleText());
    expect(prompt).toContain('files:');
    expect(prompt).not.toMatch(/at most \d+ (briefs|files)|\d+ changed lines/);
  });

  it('renders the language context section it is given', () => {
    const prompt = buildQuickPlanPrompt({
      feature: 'change feature',
      projectContext: 'repo',
      languageContext: buildLanguageContext('python'),
    });
    expect(prompt).toContain('file: src/path/to/file.py');
    expect(prompt).toContain('```python');
    expect(prompt).not.toMatch(/TypeScript|typescript|file\.ts|\.js extensions/);
  });

  it('tells trivial briefs to keep scope, escalation, and evidence concise rather than drop them', () => {
    const trivial = buildQuickPlanPrompt({
      feature: 'rename foo to bar',
      projectContext: 'repo',
      trivial: true,
    });
    const ordinary = buildQuickPlanPrompt({ feature: 'rename foo to bar', projectContext: 'repo' });
    expect(trivial).toContain(
      'Keep Scope, Escalation, and Evidence concise for trivial work, but do not omit them',
    );
    expect(ordinary).not.toContain('Keep Scope, Escalation, and Evidence concise');
  });

  it('returns task content for session persistence without requesting project writes', () => {
    const prompt = buildQuickPlanPrompt({ feature: 'change feature', projectContext: 'repo' });
    expect(prompt).toContain('SPLITBRIEF captures your reply');
    expect(prompt).toContain('persists the tasks.md artifact inside the active session');
    expect(prompt).toContain('Do not write tasks.md or any other project file yourself');
    expect(prompt).not.toContain('write it to tasks.md at the project root');
  });

  it('tells the planner to stop after the briefs — no spec, no plan — only when the work is trivial', () => {
    const trivial = buildQuickPlanPrompt({
      feature: 'rename foo to bar',
      projectContext: 'repo-map: small',
      trivial: true,
    });
    const ordinary = buildQuickPlanPrompt({
      feature: 'rename foo to bar',
      projectContext: 'repo-map: small',
    });
    expect(trivial).toContain(
      'Emit an ordered list of self-contained Task Briefs and stop — no spec, no plan.',
    );
    expect(ordinary).not.toContain('no spec, no plan');
    expect(ordinary).toContain('Briefly analyze the project, then emit an ordered list');
  });
});
