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
  it('gives the direct writer a full prompt contract', () => {
    const languageContext = buildLanguageContext('python');
    const prompt = buildImplementerSystemPreamble(languageContext, 'direct');

    expect(prompt).toContain('SYSTEM:');
    expect(prompt).toContain('Python');
    expect(prompt).toContain('Python import statements (from/import)');
    expect(prompt).toMatch(/edit only the file/i);
    expect(prompt).toMatch(/out of bounds/i);
    expect(prompt).toMatch(/stop and report/i);
    expect(prompt).toMatch(/validation commands/i);
    expect(prompt).toMatch(/completion report/i);
  });

  it('no longer describes the direct workspace as staged', () => {
    const prompt = buildImplementerSystemPreamble(buildLanguageContext('typescript'), 'direct');
    expect(prompt).not.toMatch(/staged/i);
  });

  it('reuses the complete-file preamble for extracted-code implementers', () => {
    const languageContext = buildLanguageContext('typescript');

    expect(buildImplementerSystemPreamble(languageContext, 'extracted-code')).toBe(
      buildSystemPreamble(languageContext),
    );
  });
});
