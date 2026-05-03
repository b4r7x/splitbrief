import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';
import { createTempDir, cleanupTempDir } from '#testing/helpers/temp-dir.js';
import {
  buildLanguageContext,
  buildLanguageContextSections,
  codeFenceLanguage,
  detectPromptLanguage,
  extractLanguageFromResearch,
  isJavaScriptLikeLanguage,
  normalizeLanguage,
} from './language-context.js';

describe('buildLanguageContext', () => {
  it('typescript returns ESM conventions', () => {
    const ctx = buildLanguageContext('typescript');
    expect(ctx.language).toBe('TypeScript');
    expect(ctx.importConvention).toContain('ESM');
    expect(ctx.typeAnnotationStyle).toContain('TypeScript');
    expect(ctx.fileExtension).toBe('.ts');
  });

  it('python returns Python conventions', () => {
    const ctx = buildLanguageContext('python');
    expect(ctx.language).toBe('Python');
    expect(ctx.importConvention).toContain('Python');
    expect(ctx.typeAnnotationStyle).toContain('PEP 484');
    expect(ctx.fileExtension).toBe('.py');
  });

  it('go returns Go conventions', () => {
    const ctx = buildLanguageContext('go');
    expect(ctx.language).toBe('Go');
    expect(ctx.importConvention).toContain('Go import');
    expect(ctx.typeAnnotationStyle).toContain('Go type');
    expect(ctx.fileExtension).toBe('.go');
    expect(ctx.moduleSystem).toBe('Go packages');
  });

  it('rust returns Rust conventions', () => {
    const ctx = buildLanguageContext('rust');
    expect(ctx.language).toBe('Rust');
    expect(ctx.importConvention).toContain('use/mod');
    expect(ctx.typeAnnotationStyle).toContain('Rust');
    expect(ctx.fileExtension).toBe('.rs');
    expect(ctx.moduleSystem).toBe('Rust crates/modules');
  });

  it('javascript returns JS conventions distinct from TypeScript', () => {
    const ctx = buildLanguageContext('javascript');
    expect(ctx.language).toBe('JavaScript');
    expect(ctx.importConvention).toContain('ESM');
    expect(ctx.typeAnnotationStyle).toContain('JSDoc');
    expect(ctx.fileExtension).toBe('.js');
  });

  it('unknown language returns generic context', () => {
    const ctx = buildLanguageContext(undefined);
    expect(ctx.language).toBe('the project language');
    expect(ctx.importConvention).toContain('project language');
  });
});

describe('normalizeLanguage', () => {
  it('maps ts to typescript', () => {
    expect(normalizeLanguage('ts')).toBe('typescript');
  });

  it('maps js to javascript', () => {
    expect(normalizeLanguage('js')).toBe('javascript');
  });

  it('maps golang to go', () => {
    expect(normalizeLanguage('golang')).toBe('go');
  });

  it('maps Go (capitalized) to go', () => {
    expect(normalizeLanguage('Go')).toBe('go');
  });

  it('returns undefined for empty input', () => {
    expect(normalizeLanguage(undefined)).toBeUndefined();
    expect(normalizeLanguage('')).toBeUndefined();
    expect(normalizeLanguage('   ')).toBeUndefined();
  });

  it('does not match go inside unrelated words', () => {
    expect(normalizeLanguage('django')).not.toBe('go');
    expect(normalizeLanguage('tango')).not.toBe('go');
  });

  it('strips backticks', () => {
    expect(normalizeLanguage('`typescript`')).toBe('typescript');
  });
});

describe('isJavaScriptLikeLanguage', () => {
  it('returns true for TypeScript', () => {
    expect(isJavaScriptLikeLanguage(buildLanguageContext('typescript'))).toBe(true);
  });

  it('returns true for JavaScript', () => {
    expect(isJavaScriptLikeLanguage(buildLanguageContext('javascript'))).toBe(true);
  });

  it('returns false for Python', () => {
    expect(isJavaScriptLikeLanguage(buildLanguageContext('python'))).toBe(false);
  });

  it('returns false for Go', () => {
    expect(isJavaScriptLikeLanguage(buildLanguageContext('go'))).toBe(false);
  });

  it('returns false for Rust', () => {
    expect(isJavaScriptLikeLanguage(buildLanguageContext('rust'))).toBe(false);
  });
});

describe('codeFenceLanguage', () => {
  it('returns typescript for TypeScript', () => {
    expect(codeFenceLanguage(buildLanguageContext('typescript'))).toBe('typescript');
  });

  it('returns javascript for JavaScript', () => {
    expect(codeFenceLanguage(buildLanguageContext('javascript'))).toBe('javascript');
  });

  it('returns python for Python', () => {
    expect(codeFenceLanguage(buildLanguageContext('python'))).toBe('python');
  });

  it('returns go for Go', () => {
    expect(codeFenceLanguage(buildLanguageContext('go'))).toBe('go');
  });

  it('returns rust for Rust', () => {
    expect(codeFenceLanguage(buildLanguageContext('rust'))).toBe('rust');
  });

  it('returns empty string for unknown language', () => {
    expect(codeFenceLanguage(buildLanguageContext(undefined))).toBe('');
  });
});

describe('extractLanguageFromResearch', () => {
  it('extracts backtick-wrapped language from research markdown', () => {
    expect(extractLanguageFromResearch('**Language**: `TypeScript`')).toBe('typescript');
  });

  it('extracts bare language from research markdown', () => {
    expect(extractLanguageFromResearch('**Language**: Python')).toBe('python');
  });

  it('returns undefined when no language marker present', () => {
    expect(extractLanguageFromResearch('Some random research notes')).toBeUndefined();
  });
});

describe('buildLanguageContextSections', () => {
  it('returns empty array for TypeScript', () => {
    expect(buildLanguageContextSections(buildLanguageContext('typescript'))).toEqual([]);
  });

  it('returns empty array for JavaScript', () => {
    expect(buildLanguageContextSections(buildLanguageContext('javascript'))).toEqual([]);
  });

  it('returns a Language Context section for Python', () => {
    const [section] = buildLanguageContextSections(buildLanguageContext('python'));
    expect(section).toBeDefined();
    expect(section?.heading).toBe('Language Context');
    expect(section?.body).toContain('Python');
    expect(section?.body).toContain('PEP 484');
  });

  it('returns a Language Context section for Go', () => {
    const [section] = buildLanguageContextSections(buildLanguageContext('go'));
    expect(section).toBeDefined();
    expect(section?.heading).toBe('Language Context');
    expect(section?.body).toContain('Go');
  });

  it('returns a Language Context section for Rust', () => {
    const [section] = buildLanguageContextSections(buildLanguageContext('rust'));
    expect(section).toBeDefined();
    expect(section?.heading).toBe('Language Context');
    expect(section?.body).toContain('Rust');
  });

  it('includes all five context fields for non-JS languages', () => {
    const [section] = buildLanguageContextSections(buildLanguageContext('python'));
    expect(section).toBeDefined();
    expect(section?.body).toContain('Target language:');
    expect(section?.body).toContain('Module system:');
    expect(section?.body).toContain('Imports:');
    expect(section?.body).toContain('Types:');
    expect(section?.body).toContain('File extension:');
  });
});

describe('detectPromptLanguage', () => {
  it('detects TypeScript package projects for prompt fallback', () => {
    const tmpDir = createTempDir('prompt-language');
    try {
      writeFileSync(join(tmpDir, 'package.json'), '{"devDependencies":{"typescript":"^6.0.0"}}');
      expect(detectPromptLanguage(tmpDir)).toBe('typescript');
    } finally {
      cleanupTempDir(tmpDir);
    }
  });

  it('detects Python project markers for quick and instant planning', () => {
    const tmpDir = createTempDir('prompt-language');
    try {
      mkdirSync(join(tmpDir, 'src'));
      writeFileSync(join(tmpDir, 'pyproject.toml'), '[tool.pytest.ini_options]');
      expect(detectPromptLanguage(tmpDir)).toBe('python');
    } finally {
      cleanupTempDir(tmpDir);
    }
  });

  it('detects Rust from Cargo.toml', () => {
    const tmpDir = createTempDir('prompt-language');
    try {
      writeFileSync(join(tmpDir, 'Cargo.toml'), '[package]\nname = "myapp"');
      expect(detectPromptLanguage(tmpDir)).toBe('rust');
    } finally {
      cleanupTempDir(tmpDir);
    }
  });

  it('detects Go from go.mod', () => {
    const tmpDir = createTempDir('prompt-language');
    try {
      writeFileSync(join(tmpDir, 'go.mod'), 'module example.com/myapp');
      expect(detectPromptLanguage(tmpDir)).toBe('go');
    } finally {
      cleanupTempDir(tmpDir);
    }
  });

  it('detects JavaScript when package.json has no typescript dep', () => {
    const tmpDir = createTempDir('prompt-language');
    try {
      writeFileSync(join(tmpDir, 'package.json'), '{"dependencies":{"express":"^4.0.0"}}');
      expect(detectPromptLanguage(tmpDir)).toBe('javascript');
    } finally {
      cleanupTempDir(tmpDir);
    }
  });

  it('returns undefined when no markers found', () => {
    const tmpDir = createTempDir('prompt-language');
    try {
      expect(detectPromptLanguage(tmpDir)).toBeUndefined();
    } finally {
      cleanupTempDir(tmpDir);
    }
  });
});
