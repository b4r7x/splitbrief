import { describe, it, expect } from 'vitest';
import { buildLanguageContext } from './language-context.js';
import { buildTasksPrompt } from './tasks.js';

describe('buildTasksPrompt', () => {
  it('TypeScript project prompt keeps TypeScript conventions', () => {
    const prompt = buildTasksPrompt('spec', 'plan', buildLanguageContext('typescript'));
    expect(prompt).toContain('typescript');
    expect(prompt).toContain('.js');
    expect(prompt).toContain('file: src/path/to/file.ts');
    expect(prompt).toContain('\\`\\`\\`typescript');
  });

  it('Python project prompt has no TypeScript references', () => {
    const prompt = buildTasksPrompt('spec', 'plan', buildLanguageContext('python'));
    expect(prompt).toContain('Python');
    expect(prompt).toContain('PEP 484');
    expect(prompt).toContain('file: src/path/to/file.py');
    expect(prompt).toContain('\\`\\`\\`python');
    expect(prompt).not.toMatch(/TypeScript|typescript|\.js extensions|file\.ts/);
  });

  it('generic prompt has no language-specific references', () => {
    const prompt = buildTasksPrompt('spec', 'plan');
    expect(prompt).not.toMatch(/TypeScript|typescript|\.js extensions|file\.ts|PEP 484/);
  });
});
