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

  it('python: ruff.toml selects ruff check .', () => {
    write('ruff.toml');
    expect(pythonStack.lint(dir)).toBe('ruff check .');
  });

  it('python: [tool.ruff] in pyproject selects ruff check .', () => {
    write('pyproject.toml', '[tool.ruff]\nline-length = 100\n');
    expect(pythonStack.lint(dir)).toBe('ruff check .');
  });

  it('python: .flake8 selects flake8 and a bare project lints nothing', () => {
    expect(pythonStack.lint(dir)).toBeNull();
    write('.flake8');
    expect(pythonStack.lint(dir)).toBe('flake8');
  });

  it('python: [tool.mypy] selects mypy .', () => {
    write('pyproject.toml', '[tool.mypy]\nstrict = true\n');
    expect(pythonStack.typecheck(dir)).toBe('mypy .');
  });

  it('python: mypy.ini selects mypy .', () => {
    write('mypy.ini');
    expect(pythonStack.typecheck(dir)).toBe('mypy .');
  });

  it('python: pyrightconfig.json selects pyright and a bare project typechecks nothing', () => {
    expect(pythonStack.typecheck(dir)).toBeNull();
    write('pyrightconfig.json', '{}');
    expect(pythonStack.typecheck(dir)).toBe('pyright');
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
