import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { detectLinter, findAffectedTestFile, formatValidationError } from './validator.js';
import type { ValidationResult } from '../../types.js';

describe('detectLinter', () => {
  let tempDir: string;

  afterEach(() => {
    if (tempDir && existsSync(tempDir)) {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('returns eslint when eslint.config.js exists', () => {
    tempDir = mkdtempSync(join(tmpdir(), 'validator-test-'));
    writeFileSync(join(tempDir, 'eslint.config.js'), 'module.exports = {};');
    expect(detectLinter(tempDir)).toBe('eslint');
  });

  it('returns eslint when .eslintrc.json exists', () => {
    tempDir = mkdtempSync(join(tmpdir(), 'validator-test-'));
    writeFileSync(join(tempDir, '.eslintrc.json'), '{}');
    expect(detectLinter(tempDir)).toBe('eslint');
  });

  it('returns biome when biome.json exists', () => {
    tempDir = mkdtempSync(join(tmpdir(), 'validator-test-'));
    writeFileSync(join(tempDir, 'biome.json'), '{}');
    expect(detectLinter(tempDir)).toBe('biome');
  });

  it('returns null when neither eslint nor biome config exists', () => {
    tempDir = mkdtempSync(join(tmpdir(), 'validator-test-'));
    expect(detectLinter(tempDir)).toBe(null);
  });

  it('prefers eslint over biome when both exist', () => {
    tempDir = mkdtempSync(join(tmpdir(), 'validator-test-'));
    writeFileSync(join(tempDir, 'eslint.config.mjs'), 'export default [];');
    writeFileSync(join(tempDir, 'biome.json'), '{}');
    expect(detectLinter(tempDir)).toBe('eslint');
  });
});

describe('findAffectedTestFile', () => {
  let tempDir: string;

  afterEach(() => {
    if (tempDir && existsSync(tempDir)) {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('maps src/foo.ts to tests/foo.test.ts when test file exists', () => {
    tempDir = mkdtempSync(join(tmpdir(), 'validator-test-'));
    mkdirSync(join(tempDir, 'tests'), { recursive: true });
    writeFileSync(join(tempDir, 'tests', 'foo.test.ts'), '');
    expect(findAffectedTestFile('src/foo.ts', tempDir)).toBe(join(tempDir, 'tests', 'foo.test.ts'));
  });

  it('maps src/utils/bar.ts to tests/utils/bar.test.ts when test file exists', () => {
    tempDir = mkdtempSync(join(tmpdir(), 'validator-test-'));
    mkdirSync(join(tempDir, 'tests', 'utils'), { recursive: true });
    writeFileSync(join(tempDir, 'tests', 'utils', 'bar.test.ts'), '');
    expect(findAffectedTestFile('src/utils/bar.ts', tempDir)).toBe(join(tempDir, 'tests', 'utils', 'bar.test.ts'));
  });

  it('returns null when no matching test file found', () => {
    tempDir = mkdtempSync(join(tmpdir(), 'validator-test-'));
    expect(findAffectedTestFile('src/missing.ts', tempDir)).toBe(null);
  });
});

describe('formatValidationError', () => {
  it('returns empty string when all passed', () => {
    const results: ValidationResult[] = [
      { passed: true, stage: 'typecheck', output: 'ok' },
      { passed: true, stage: 'lint', output: 'ok' },
    ];
    expect(formatValidationError(results)).toBe('');
  });

  it('returns empty string for empty results', () => {
    expect(formatValidationError([])).toBe('');
  });

  it('extracts first failed result', () => {
    const results: ValidationResult[] = [
      { passed: true, stage: 'typecheck', output: 'ok' },
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
      { passed: false, stage: 'typecheck', error: longError },
    ];
    const error = formatValidationError(results);
    expect(error).not.toContain('Error line 21');
    expect(error).toContain('Error line 20');
  });
});
