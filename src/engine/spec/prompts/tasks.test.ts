import { describe, it, expect } from 'vitest';
import { sliceRuleText } from '../../../core/pipeline-spec/brief.js';
import { buildLanguageContext } from './language-context.js';
import { briefContract, buildTasksPrompt } from './tasks.js';

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

  it('keeps the nine numbered sections ahead of the rule', () => {
    expect(contract).toContain('1. **Identity**');
    expect(contract).toContain('9. **Evidence**');
    expect(contract.indexOf('9. **Evidence**')).toBeLessThan(
      contract.indexOf('Every brief must also leave typecheck'),
    );
  });
});

describe('the planner gives gates to SPLITBRIEF and treats scope as guidance', () => {
  const prompt = buildTasksPrompt({ spec: 'spec', plan: 'plan' });

  it.each([
    'Name the focused test files and cases only. SPLITBRIEF runs typecheck, lint and the affected tests after every brief, so never tell the implementer to run a project-wide gate, the whole suite, or a screenshot/render tool.',
    "(the focused tests that pass, the changed files, the behavior a reviewer can check). Renders and project-wide gates are the review seat's and SPLITBRIEF's evidence, not the implementer's steps.",
    '`files` are the suggested files; **In bounds** is context; **Out of bounds** lists the explicit exclusions the reviewer checks.',
  ])('says %j once', (sentence) => {
    expect(prompt.split(sentence)).toHaveLength(2);
  });

  it('drops the scope fence and the gate-running evidence', () => {
    expect(prompt).not.toContain('so the implementer cannot drift into adjacent files');
    expect(prompt).not.toContain(
      '(passing tests, validation output, changed files, behavioral note)',
    );
  });
});

describe('buildTasksPrompt', () => {
  it('TypeScript project prompt keeps TypeScript conventions', () => {
    const prompt = buildTasksPrompt({
      spec: 'spec',
      plan: 'plan',
      languageContext: buildLanguageContext('typescript'),
    });
    expect(prompt).toContain('typescript');
    expect(prompt).toContain('.js');
    expect(prompt).toContain('file: src/path/to/file.ts');
    expect(prompt).toContain('```typescript');
  });

  it('Python project prompt has no TypeScript references', () => {
    const prompt = buildTasksPrompt({
      spec: 'spec',
      plan: 'plan',
      languageContext: buildLanguageContext('python'),
    });
    expect(prompt).toContain('Python');
    expect(prompt).toContain('PEP 484');
    expect(prompt).toContain('file: src/path/to/file.py');
    expect(prompt).toContain('```python');
    expect(prompt).not.toMatch(/TypeScript|typescript|\.js extensions|file\.ts/);
  });

  it('generic prompt has no language-specific references', () => {
    const prompt = buildTasksPrompt({ spec: 'spec', plan: 'plan' });
    expect(prompt).not.toMatch(/TypeScript|typescript|\.js extensions|file\.ts|PEP 484/);
  });

  it('returns task content for session persistence without requesting project writes', () => {
    const prompt = buildTasksPrompt({ spec: 'spec', plan: 'plan' });
    expect(prompt).toContain('SPLITBRIEF captures your reply');
    expect(prompt).toContain('persists the tasks.md artifact inside the active session');
    expect(prompt).toContain('Do not write tasks.md or any other project file yourself');
    expect(prompt).not.toContain('write it to tasks.md at the project root');
  });

  it('groups briefs by coherent outcome with no count, file or line quota', () => {
    const prompt = buildTasksPrompt({ spec: 'spec', plan: 'plan' });
    expect(prompt).toContain('Each brief delivers one coherent outcome');
    expect(prompt).toContain(`**Coherent**: ${sliceRuleText()}`);
    expect(prompt).toContain('files:');
    expect(prompt).not.toMatch(/at most \d+ (briefs|files)|\d+ changed lines|briefs in all/);
  });

  it('carries the active skills section after the implementation plan', () => {
    const prompt = buildTasksPrompt({
      spec: 'spec',
      plan: 'plan',
      skillsContext: '## Active Project Skills\n\n### AuthSkill\nSKILL-BODY',
    });
    expect(prompt).toContain('## Implementation Plan\nplan\n\n## Active Project Skills');
    expect(prompt).toContain('SKILL-BODY');
  });

  it('tells the planner every brief carries the skills, so no brief copies or cites them', () => {
    const prompt = buildTasksPrompt({
      spec: 'spec',
      plan: 'plan',
      skillsContext: '## Active Project Skills\n\n### AuthSkill\nSKILL-BODY',
    });
    expect(prompt).toContain(
      'Every brief reaches the implementer together with the Active Project Skills section: do not copy that section into a brief, and do not point a brief at skill files.',
    );
  });

  it('omits the skills section when no skill is attached', () => {
    expect(buildTasksPrompt({ spec: 'spec', plan: 'plan' })).not.toContain('Active Project Skills');
  });

  it('reserves bare separators for Task Brief frontmatter', () => {
    const prompt = buildTasksPrompt({ spec: 'spec', plan: 'plan' });
    expect(prompt).toContain(
      'Outside fenced code blocks, lines containing only `---` are reserved',
    );
    expect(prompt).toContain(
      'Never use a bare `---` as a horizontal rule or phase-heading separator',
    );
  });
});
