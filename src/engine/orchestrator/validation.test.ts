import { describe, it, expect, afterEach } from 'vitest';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { createValidator, formatValidationError } from './validation.js';
import type { ValidationResult } from '../../core/types/summary.js';
import { createTempDir, cleanupTempDir } from '#testing/helpers/temp-dir.js';

describe('detectLinter', () => {
  let tempDir: string;

  afterEach(() => {
    if (tempDir) cleanupTempDir(tempDir);
  });

  it('returns eslint when eslint.config.js exists', () => {
    tempDir = createTempDir('validator-test');
    writeFileSync(join(tempDir, 'eslint.config.js'), 'module.exports = {};');
    expect(createValidator().detectLinter(tempDir)).toBe('eslint');
  });

  it('returns eslint when .eslintrc.json exists', () => {
    tempDir = createTempDir('validator-test');
    writeFileSync(join(tempDir, '.eslintrc.json'), '{}');
    expect(createValidator().detectLinter(tempDir)).toBe('eslint');
  });

  it('returns biome when biome.json exists', () => {
    tempDir = createTempDir('validator-test');
    writeFileSync(join(tempDir, 'biome.json'), '{}');
    expect(createValidator().detectLinter(tempDir)).toBe('biome');
  });

  it('returns null when neither eslint nor biome config exists', () => {
    tempDir = createTempDir('validator-test');
    expect(createValidator().detectLinter(tempDir)).toBe(null);
  });

  it('prefers eslint over biome when both exist', () => {
    tempDir = createTempDir('validator-test');
    writeFileSync(join(tempDir, 'eslint.config.mjs'), 'export default [];');
    writeFileSync(join(tempDir, 'biome.json'), '{}');
    expect(createValidator().detectLinter(tempDir)).toBe('eslint');
  });

  it('caches two different project dirs independently without cross-project bleed', () => {
    const dirA = createTempDir('validator-test-a');
    const dirB = createTempDir('validator-test-b');
    try {
      writeFileSync(join(dirA, 'biome.json'), '{}');
      writeFileSync(join(dirB, 'eslint.config.js'), 'module.exports = {};');

      const v = createValidator();
      expect(v.detectLinter(dirA)).toBe('biome');
      expect(v.detectLinter(dirB)).toBe('eslint');

      expect(v.detectLinter(dirA)).toBe('biome');
      expect(v.detectLinter(dirB)).toBe('eslint');
    } finally {
      cleanupTempDir(dirA);
      cleanupTempDir(dirB);
    }
  });
});

describe('findAffectedTestFile', () => {
  let tempDir: string;

  afterEach(() => {
    if (tempDir) cleanupTempDir(tempDir);
  });

  it('maps src/foo.ts to tests/foo.test.ts when test file exists', () => {
    tempDir = createTempDir('validator-test');
    mkdirSync(join(tempDir, 'tests'), { recursive: true });
    writeFileSync(join(tempDir, 'tests', 'foo.test.ts'), '');
    expect(createValidator().findAffectedTestFile('src/foo.ts', tempDir)).toBe(join(tempDir, 'tests', 'foo.test.ts'));
  });

  it('maps src/utils/bar.ts to tests/utils/bar.test.ts when test file exists', () => {
    tempDir = createTempDir('validator-test');
    mkdirSync(join(tempDir, 'tests', 'utils'), { recursive: true });
    writeFileSync(join(tempDir, 'tests', 'utils', 'bar.test.ts'), '');
    expect(createValidator().findAffectedTestFile('src/utils/bar.ts', tempDir)).toBe(join(tempDir, 'tests', 'utils', 'bar.test.ts'));
  });

  it('returns null when no matching test file found', () => {
    tempDir = createTempDir('validator-test');
    expect(createValidator().findAffectedTestFile('src/missing.ts', tempDir)).toBe(null);
  });
});

describe('formatValidationError', () => {
  it('returns empty string when all passed', () => {
    const results: ValidationResult[] = [
      { passed: true, stage: 'tsc', output: 'ok' },
      { passed: true, stage: 'lint', output: 'ok' },
    ];
    expect(formatValidationError(results)).toBe('');
  });

  it('returns empty string for empty results', () => {
    expect(formatValidationError([])).toBe('');
  });

  it('extracts first failed result', () => {
    const results: ValidationResult[] = [
      { passed: true, stage: 'tsc', output: 'ok' },
      { passed: false, stage: 'lint', error: 'Unexpected token' },
      { passed: false, stage: 'test', error: 'Test failed' },
    ];
    const error = formatValidationError(results);
    expect(error).toContain('lint');
    expect(error).toContain('Unexpected token');
  });

  it('truncates error to 20 lines', () => {
    const longError = Array.from({ length: 30 }, (_, i) => `Error line ${i + 1}`).join('\n');
    const results: ValidationResult[] = [
      { passed: false, stage: 'tsc', error: longError },
    ];
    const error = formatValidationError(results);
    expect(error).not.toContain('Error line 21');
    expect(error).toContain('Error line 20');
  });
});
