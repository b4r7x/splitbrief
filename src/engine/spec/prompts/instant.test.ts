import { describe, it, expect } from 'vitest';
import { buildLanguageContext } from './language-context.js';
import { buildInstantPrompt } from './instant.js';
import { buildQuickPlanPrompt } from './quick-plan.js';

describe('buildInstantPrompt', () => {
  it('requests only a Tasks section (no Spec / no Plan)', () => {
    const prompt = buildInstantPrompt('rename foo to bar', 'repo-map: small');
    expect(prompt).toMatch(/tasks/i);
    expect(prompt).not.toMatch(/^##\s+Spec\b/im);
    expect(prompt).not.toMatch(/^##\s+Plan\b/im);
  });

  it('mentions trivial / small model constraint', () => {
    const prompt = buildInstantPrompt('x', 'y');
    expect(prompt.toLowerCase()).toContain('small');
  });

  it('requires Task Brief v1 scope, escalation, and evidence sections', () => {
    const prompt = buildInstantPrompt('x', 'y');
    expect(prompt).toContain(
      'Scope, Implementation Steps, Tests (Validation), Constraints, Escalation, Evidence',
    );
    expect(prompt).toContain('do not omit them');
    expect(prompt).not.toContain('optional in instant mode');
  });

  it('uses Python task examples when Python context is provided', () => {
    const prompt = buildInstantPrompt('x', 'y', buildLanguageContext('python'));
    expect(prompt).toContain('file: src/path/to/file.py');
    expect(prompt).toContain('```python');
    expect(prompt).toContain('PEP 484');
    expect(prompt).not.toMatch(/TypeScript|typescript|file\.ts|\.js extensions/);
  });

  it('returns task content for session persistence without requesting project writes', () => {
    const prompt = buildInstantPrompt('x', 'y');
    expect(prompt).toContain('SPLITBRIEF captures your reply');
    expect(prompt).toContain('persists the tasks.md artifact inside the active session');
    expect(prompt).toContain('Do not write tasks.md or any other project file yourself');
    expect(prompt).not.toContain('write it to tasks.md at the project root');
  });

  it('reserves bare separators for Task Brief frontmatter', () => {
    const prompt = buildInstantPrompt('x', 'y');
    expect(prompt).toContain(
      'Outside fenced code blocks, lines containing only `---` are reserved',
    );
    expect(prompt).toContain(
      'Never use a bare `---` as a horizontal rule or phase-heading separator',
    );
  });
});

describe('buildQuickPlanPrompt', () => {
  it('does not weaken Task Brief v1 scope, escalation, or evidence sections', () => {
    const prompt = buildQuickPlanPrompt('change feature', 'repo');
    expect(prompt).toContain(
      'Scope, Implementation Steps, Tests (Validation), Constraints, Escalation, Evidence',
    );
    expect(prompt).toContain('must include');
    expect(prompt).toContain('must state when the implementer should stop');
    expect(prompt).toContain('must state the reviewable proof');
    expect(prompt).not.toContain('whenever the change touches');
    expect(prompt).not.toContain('when the brief should leave behind');
  });

  it('uses Python task examples when Python context is provided', () => {
    const prompt = buildQuickPlanPrompt('change feature', 'repo', buildLanguageContext('python'));
    expect(prompt).toContain('file: src/path/to/file.py');
    expect(prompt).toContain('```python');
    expect(prompt).not.toMatch(/TypeScript|typescript|file\.ts|\.js extensions/);
  });

  it('returns task content for session persistence without requesting project writes', () => {
    const prompt = buildQuickPlanPrompt('change feature', 'repo');
    expect(prompt).toContain('SPLITBRIEF captures your reply');
    expect(prompt).toContain('persists the tasks.md artifact inside the active session');
    expect(prompt).toContain('Do not write tasks.md or any other project file yourself');
    expect(prompt).not.toContain('write it to tasks.md at the project root');
  });

  it('reserves bare separators for Task Brief frontmatter', () => {
    const prompt = buildQuickPlanPrompt('change feature', 'repo');
    expect(prompt).toContain(
      'Outside fenced code blocks, lines containing only `---` are reserved',
    );
    expect(prompt).toContain(
      'Never use a bare `---` as a horizontal rule or phase-heading separator',
    );
  });
});
