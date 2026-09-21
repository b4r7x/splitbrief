import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cleanupTempDir, createTempDir } from '#testing/helpers/temp-dir.js';
import { VALIDATION_STAGES } from '../schemas/enums.js';
import { readManifestCommands } from './manifest-commands.js';
import { pythonStack } from './stacks/python.js';

describe('readManifestCommands', () => {
  let dir: string;
  beforeEach(() => {
    dir = createTempDir('manifest-commands');
  });
  afterEach(() => {
    cleanupTempDir(dir);
  });

  it('package.json scripts.typecheck → npm run typecheck', () => {
    writeFileSync(
      join(dir, 'package.json'),
      JSON.stringify({ scripts: { typecheck: 'tsc --noEmit', test: 'vitest run' } }),
    );
    expect(readManifestCommands(dir)).toEqual({ typecheck: 'npm run typecheck', test: 'npm test' });
  });

  it('Makefile target test → make test', () => {
    writeFileSync(join(dir, 'Makefile'), 'lint:\n\truff check .\ntest:\n\tpytest\n');
    expect(readManifestCommands(dir)).toEqual({ lint: 'make lint', test: 'make test' });
  });

  it('justfile target lint → just lint', () => {
    writeFileSync(join(dir, 'justfile'), 'lint:\n    ruff check .\n');
    expect(readManifestCommands(dir).lint).toBe('just lint');
  });

  it('pyproject sections map to their stack commands', () => {
    writeFileSync(
      join(dir, 'pyproject.toml'),
      '[tool.mypy]\nstrict = true\n\n[tool.ruff]\n\n[tool.pytest.ini_options]\n',
    );
    const commands = readManifestCommands(dir);
    expect(commands).toEqual({ typecheck: 'mypy .', lint: 'ruff check .', test: 'pytest' });
    expect([commands.typecheck, commands.lint]).toEqual([
      pythonStack.typecheck(dir),
      pythonStack.lint(dir),
    ]);
  });

  it('offers a command for every validation stage', () => {
    writeFileSync(
      join(dir, 'Makefile'),
      VALIDATION_STAGES.map((stage) => `${stage}:\n\techo ${stage}\n`).join(''),
    );
    expect(Object.keys(readManifestCommands(dir))).toEqual([...VALIDATION_STAGES]);
  });

  it('a package script beats a Makefile target', () => {
    writeFileSync(
      join(dir, 'package.json'),
      JSON.stringify({ scripts: { lint: 'biome check .' } }),
    );
    writeFileSync(join(dir, 'Makefile'), 'lint:\n\techo no\n');
    expect(readManifestCommands(dir).lint).toBe('npm run lint');
  });

  it('an empty project yields no commands', () => {
    expect(readManifestCommands(dir)).toEqual({});
  });
});
