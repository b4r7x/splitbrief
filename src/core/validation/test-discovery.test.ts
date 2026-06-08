import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { findAffectedTestFile, isTestPatternSafe } from './test-discovery.js';

describe('findAffectedTestFile', () => {
  let tmpDir: string;
  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'test-disc-'));
    mkdirSync(join(tmpDir, 'src'), { recursive: true });
  });
  afterEach(() => {
    rmSync(tmpDir, { recursive: true });
  });

  it('finds Go test file with custom pattern', () => {
    writeFileSync(join(tmpDir, 'src', 'handler_test.go'), '');
    const result = findAffectedTestFile('src/handler.go', tmpDir, '*_test.go');
    expect(result).toContain('handler_test.go');
  });

  it('finds TS test file with default pattern', () => {
    writeFileSync(join(tmpDir, 'src', 'handler.test.ts'), '');
    const result = findAffectedTestFile('src/handler.ts', tmpDir);
    expect(result).toContain('handler.test.ts');
  });

  it('returns null when no test file exists', () => {
    const result = findAffectedTestFile('src/handler.go', tmpDir, '*_test.go');
    expect(result).toBeNull();
  });

  it('finds Python test file with prefix pattern', () => {
    writeFileSync(join(tmpDir, 'src', 'test_handler.py'), '');
    const result = findAffectedTestFile('src/handler.py', tmpDir, 'test_*.py');
    expect(result).toContain('test_handler.py');
  });

  it('returns null for traversal test patterns', () => {
    writeFileSync(join(tmpDir, 'src', 'handler.test.ts'), '');
    expect(findAffectedTestFile('src/handler.ts', tmpDir, '../secret.test.ts')).toBeNull();
    expect(findAffectedTestFile('src/handler.ts', tmpDir, '../../outside.test.ts')).toBeNull();
  });
});

describe('isTestPatternSafe', () => {
  it('rejects path separators and parent traversal', () => {
    expect(isTestPatternSafe('*.test.ts')).toBe(true);
    expect(isTestPatternSafe('../secret.test.ts')).toBe(false);
    expect(isTestPatternSafe('nested/handler.test.ts')).toBe(false);
    expect(isTestPatternSafe('')).toBe(false);
  });
});
