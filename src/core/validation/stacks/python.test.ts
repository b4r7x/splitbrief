import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cleanupTempDir, createTempDir } from '#testing/helpers/temp-dir.js';
import { pythonStack } from './python.js';

describe('pythonStack', () => {
  let dir: string;
  beforeEach(() => {
    dir = createTempDir('stack-py');
  });
  afterEach(() => {
    cleanupTempDir(dir);
  });

  function write(file: string, body = ''): void {
    writeFileSync(join(dir, file), body);
  }

  it('python: uv.lock selects uv run pytest', () => {
    write('uv.lock');
    expect(pythonStack.test(dir)).toBe('uv run pytest');
  });

  it('python: poetry.lock selects poetry run pytest', () => {
    write('poetry.lock');
    expect(pythonStack.test(dir)).toBe('poetry run pytest');
  });

  it('python: no lockfile falls back to pytest', () => {
    expect(pythonStack.test(dir)).toBe('pytest');
  });

  it('declares the documented markers, patterns and narrowing', () => {
    expect(pythonStack.markers).toEqual([
      'pyproject.toml',
      'setup.py',
      'setup.cfg',
      'requirements.txt',
      'Pipfile',
    ]);
    expect(pythonStack.testFilePatterns).toEqual(['test_*.py', '*_test.py']);
    expect(pythonStack.testDirs).toEqual(['tests', 'test']);
    expect(pythonStack.narrowing).toEqual({ kind: 'path-arg', separator: '' });
  });
});
