import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cleanupTempDir, createTempDir } from '#testing/helpers/temp-dir.js';
import { readManifestCommands } from './manifest-commands.js';
import { PYPROJECT_TEST } from './stacks/python.js';

describe('readManifestCommands', () => {
  let dir: string;
  beforeEach(() => {
    dir = createTempDir('manifest-commands');
  });
  afterEach(() => {
    cleanupTempDir(dir);
  });

  it('package.json scripts.test → npm test', () => {
    writeFileSync(
      join(dir, 'package.json'),
      JSON.stringify({ scripts: { typecheck: 'tsc --noEmit', test: 'vitest run' } }),
    );
    expect(readManifestCommands(dir)).toEqual({ test: 'npm test' });
  });

  it('Makefile target test → make test', () => {
    writeFileSync(join(dir, 'Makefile'), 'lint:\n\truff check .\ntest:\n\tpytest\n');
    expect(readManifestCommands(dir)).toEqual({ test: 'make test' });
  });

  it('justfile target test → just test', () => {
    writeFileSync(join(dir, 'justfile'), 'test:\n    pytest\n');
    expect(readManifestCommands(dir)).toEqual({ test: 'just test' });
  });

  it('a Makefile without a test target yields no command', () => {
    writeFileSync(join(dir, 'Makefile'), 'lint:\n\truff check .\n');
    expect(readManifestCommands(dir)).toEqual({});
  });

  it('the pyproject pytest section maps to the stack test command', () => {
    writeFileSync(
      join(dir, 'pyproject.toml'),
      '[tool.mypy]\nstrict = true\n\n[tool.ruff]\n\n[tool.pytest.ini_options]\n',
    );
    expect(readManifestCommands(dir)).toEqual({ test: PYPROJECT_TEST.command });
  });

  it('a package test script beats a Makefile target', () => {
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ scripts: { test: 'vitest run' } }));
    writeFileSync(join(dir, 'Makefile'), 'test:\n\techo no\n');
    expect(readManifestCommands(dir).test).toBe('npm test');
  });

  it('an empty project yields no commands', () => {
    expect(readManifestCommands(dir)).toEqual({});
  });
});
