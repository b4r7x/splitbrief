import { describe, it, expect } from 'vitest';
import { buildLanguageContext } from './language-context.js';
import { buildTasksPrompt } from './tasks.js';

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

  it('describes a brief as a slice with a file budget instead of one file', () => {
    const prompt = buildTasksPrompt({ spec: 'spec', plan: 'plan' });
    expect(prompt).toContain('One brief = one verifiable slice');
    expect(prompt).toContain('at most 5 files');
    expect(prompt).toContain('files:');
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
