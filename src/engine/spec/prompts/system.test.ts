import { describe, it, expect } from 'vitest';
import { buildLanguageContext } from './language-context.js';
import { buildImplementerSystemPreamble, buildSystemPreamble } from './system.js';

describe('buildSystemPreamble', () => {
  it('TypeScript preamble keeps TypeScript conventions', () => {
    const prompt = buildSystemPreamble(buildLanguageContext('typescript'));
    expect(prompt).toContain('TypeScript code generator');
    expect(prompt).toContain('ESM imports with .js extensions');
    expect(prompt).toContain('import type { Config } from');
    expect(prompt).toContain('dir: string');
  });

  it('Python preamble has no TypeScript references', () => {
    const prompt = buildSystemPreamble(buildLanguageContext('python'));
    expect(prompt).toContain('Python code generator');
    expect(prompt).toContain('Python import statements');
    expect(prompt).toContain('def load_config(directory: str)');
    expect(prompt).not.toMatch(/TypeScript|typescript|import type|\.js extensions|dir: string/);
  });

  it('generic preamble avoids language-specific examples', () => {
    const prompt = buildSystemPreamble();
    expect(prompt).toContain('project language');
    expect(prompt).not.toMatch(/TypeScript|typescript|PEP 484|\.js extensions/);
  });
});

describe('buildImplementerSystemPreamble', () => {
  it('keeps the direct-writer editing contract', () => {
    const languageContext = buildLanguageContext('python');

    expect(buildImplementerSystemPreamble(languageContext, 'direct')).toBe(
      `SYSTEM: You are a coding agent for Python. You write clean, working code directly in the staged working directory.
Rules:
- Do NOT add comments unless specified in the task
- Use Python import statements (from/import)
- Follow the exact function signatures provided`,
    );
  });

  it('reuses the complete-file preamble for extracted-code implementers', () => {
    const languageContext = buildLanguageContext('typescript');

    expect(buildImplementerSystemPreamble(languageContext, 'extracted-code')).toBe(
      buildSystemPreamble(languageContext),
    );
  });
});
