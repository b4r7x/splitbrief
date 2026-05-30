import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { cleanupTempDir, createTempDir } from '#testing/helpers/temp-dir.js';
import {
  buildLanguageContext,
  buildLanguageContextSections,
  codeFenceLanguage,
  detectPromptLanguage,
  extractLanguageFromResearch,
  isJavaScriptLikeLanguage,
  normalizeLanguage,
} from './language-context.js';

function withTempProject(fn: (dir: string) => void): void {
  const tmpDir = createTempDir('prompt-language');
  try {
    fn(tmpDir);
  } finally {
    cleanupTempDir(tmpDir);
  }
}

describe('buildLanguageContext', () => {
  it.each([
    ['typescript', 'TypeScript', 'ESM', 'TypeScript', '.ts', 'ESM'],
    ['javascript', 'JavaScript', 'ESM', 'JSDoc', '.js', 'ESM'],
    ['python', 'Python', 'Python', 'PEP 484', '.py', 'Python modules'],
    ['go', 'Go', 'Go import', 'Go type', '.go', 'Go packages'],
    ['rust', 'Rust', 'use/mod', 'Rust', '.rs', 'Rust crates/modules'],
    [
      undefined,
      'the project language',
      'project language',
      'project language',
      '',
      'the project module system',
    ],
  ] as const)('returns conventions for %s', (input, language, importText, typeText, fileExtension, moduleSystem) => {
    const ctx = buildLanguageContext(input);

    expect(ctx.language).toBe(language);
    expect(ctx.importConvention).toContain(importText);
    expect(ctx.typeAnnotationStyle).toContain(typeText);
    expect(ctx.fileExtension).toBe(fileExtension);
    expect(ctx.moduleSystem).toBe(moduleSystem);
  });
});

describe('normalizeLanguage', () => {
  it.each([
    ['ts', 'typescript'],
    ['js', 'javascript'],
    ['golang', 'go'],
    ['Go', 'go'],
    ['`typescript`', 'typescript'],
    ['django', 'django'],
    ['tango', 'tango'],
    [undefined, undefined],
    ['', undefined],
    ['   ', undefined],
  ] as const)('normalizes %s to %s', (input, expected) => {
    expect(normalizeLanguage(input)).toBe(expected);
  });
});

describe('language helpers', () => {
  it.each([
    ['typescript', true, 'typescript'],
    ['javascript', true, 'javascript'],
    ['python', false, 'python'],
    ['go', false, 'go'],
    ['rust', false, 'rust'],
    [undefined, false, ''],
  ] as const)('classifies %s', (input, isJsLike, fenceLanguage) => {
    const ctx = buildLanguageContext(input);

    expect(isJavaScriptLikeLanguage(ctx)).toBe(isJsLike);
    expect(codeFenceLanguage(ctx)).toBe(fenceLanguage);
  });

  it.each([
    ['**Language**: `TypeScript`', 'typescript'],
    ['**Language**: Python', 'python'],
    ['Some random research notes', undefined],
  ] as const)('extracts language from research', (research, expected) => {
    expect(extractLanguageFromResearch(research)).toBe(expected);
  });
});

describe('buildLanguageContextSections', () => {
  it.each(['typescript', 'javascript'] as const)('omits language section for %s', (language) => {
    expect(buildLanguageContextSections(buildLanguageContext(language))).toEqual([]);
  });

  it.each([
    ['python', 'Python', 'PEP 484'],
    ['go', 'Go', 'Go packages'],
    ['rust', 'Rust', 'Rust crates/modules'],
  ] as const)('returns a complete Language Context section for %s', (language, languageText, detailText) => {
    const [section] = buildLanguageContextSections(buildLanguageContext(language));

    expect(section).toMatchObject({ heading: 'Language Context' });
    expect(section?.body).toContain(languageText);
    expect(section?.body).toContain(detailText);
    expect(section?.body).toContain('Target language:');
    expect(section?.body).toContain('Module system:');
    expect(section?.body).toContain('Imports:');
    expect(section?.body).toContain('Types:');
    expect(section?.body).toContain('File extension:');
  });
});

describe('detectPromptLanguage', () => {
  it.each([
    [
      'TypeScript package projects',
      (dir: string) =>
        writeFileSync(join(dir, 'package.json'), '{"devDependencies":{"typescript":"^6.0.0"}}'),
      'typescript',
    ],
    [
      'Python project markers',
      (dir: string) => {
        mkdirSync(join(dir, 'src'));
        writeFileSync(join(dir, 'pyproject.toml'), '[tool.pytest.ini_options]');
      },
      'python',
    ],
    [
      'Rust from Cargo.toml',
      (dir: string) => writeFileSync(join(dir, 'Cargo.toml'), '[package]\nname = "myapp"'),
      'rust',
    ],
    [
      'Go from go.mod',
      (dir: string) => writeFileSync(join(dir, 'go.mod'), 'module example.com/myapp'),
      'go',
    ],
    [
      'JavaScript package projects',
      (dir: string) =>
        writeFileSync(join(dir, 'package.json'), '{"dependencies":{"express":"^4.0.0"}}'),
      'javascript',
    ],
    ['unknown projects', () => {}, undefined],
  ] as const)('detects %s', (_name, arrange, expected) => {
    withTempProject((tmpDir) => {
      arrange(tmpDir);
      expect(detectPromptLanguage(tmpDir)).toBe(expected);
    });
  });
});
