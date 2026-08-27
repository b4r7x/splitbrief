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

  it('resolves a task whose file is itself a TS test file to that file', () => {
    writeFileSync(join(tmpDir, 'src', 'text.test.ts'), '');
    expect(findAffectedTestFile('src/text.test.ts', tmpDir)).toBe(
      join(tmpDir, 'src', 'text.test.ts'),
    );
  });

  it('resolves a task whose file matches the custom test pattern to that file', () => {
    writeFileSync(join(tmpDir, 'src', 'handler_test.go'), '');
    expect(findAffectedTestFile('src/handler_test.go', tmpDir, '*_test.go')).toBe(
      join(tmpDir, 'src', 'handler_test.go'),
    );
    writeFileSync(join(tmpDir, 'src', 'test_handler.py'), '');
    expect(findAffectedTestFile('src/test_handler.py', tmpDir, 'test_*.py')).toBe(
      join(tmpDir, 'src', 'test_handler.py'),
    );
  });

  it('returns null for a test-file task that does not exist on disk', () => {
    expect(findAffectedTestFile('src/missing.test.ts', tmpDir)).toBeNull();
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

  it('maps src/foo.ts to tests/foo.test.ts when test file exists', () => {
    mkdirSync(join(tmpDir, 'tests'), { recursive: true });
    writeFileSync(join(tmpDir, 'tests', 'foo.test.ts'), '');
    expect(findAffectedTestFile('src/foo.ts', tmpDir)).toBe(join(tmpDir, 'tests', 'foo.test.ts'));
  });

  it('maps src/utils/bar.ts to tests/utils/bar.test.ts when test file exists', () => {
    mkdirSync(join(tmpDir, 'tests', 'utils'), { recursive: true });
    writeFileSync(join(tmpDir, 'tests', 'utils', 'bar.test.ts'), '');
    expect(findAffectedTestFile('src/utils/bar.ts', tmpDir)).toBe(
      join(tmpDir, 'tests', 'utils', 'bar.test.ts'),
    );
  });

  it('returns null when no matching test file found', () => {
    expect(findAffectedTestFile('src/missing.ts', tmpDir)).toBe(null);
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
