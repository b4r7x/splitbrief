import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { findTestingHelperImportViolations } from './testing-helper-imports.js';

describe('findTestingHelperImportViolations', () => {
  let root: string;

  const write = (relPath: string, source: string): void => {
    const fullPath = join(root, relPath);
    mkdirSync(dirname(fullPath), { recursive: true });
    writeFileSync(fullPath, source);
  };

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'testing-helper-imports-'));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('flags e2e tests importing top-level testing/helpers through a relative path', () => {
    write('testing/helpers/temp-dir.ts', 'export const tempDir = "tmp";');
    write(
      'testing/e2e/scenarios/smoke.test.ts',
      "import { tempDir } from '../../helpers/temp-dir.js';\nexpect(tempDir).toBe('tmp');\n",
    );

    expect(findTestingHelperImportViolations(root)).toEqual([
      {
        file: 'testing/e2e/scenarios/smoke.test.ts',
        line: 1,
        importPath: '../../helpers/temp-dir.js',
        resolvedPath: 'testing/helpers/temp-dir.js',
      },
    ]);
  });

  it('allows e2e tests importing e2e-local helpers through a relative path', () => {
    write('testing/e2e/helpers/config.ts', 'export const config = {};');
    write(
      'testing/e2e/scenarios/smoke.test.ts',
      "import { config } from '../helpers/config.js';\nexpect(config).toEqual({});\n",
    );

    expect(findTestingHelperImportViolations(root)).toEqual([]);
  });

  it('allows top-level testing/helpers imports through the #testing alias', () => {
    write('testing/helpers/temp-dir.ts', 'export const tempDir = "tmp";');
    write(
      'testing/e2e/scenarios/smoke.test.ts',
      "import { tempDir } from '#testing/helpers/temp-dir.js';\nexpect(tempDir).toBe('tmp');\n",
    );

    expect(findTestingHelperImportViolations(root)).toEqual([]);
  });

  it('allows testing/helpers tests to import the helper under test by relative path', () => {
    write('testing/helpers/temp-dir.ts', 'export const tempDir = "tmp";');
    write(
      'testing/helpers/temp-dir.test.ts',
      "import { tempDir } from './temp-dir.js';\nexpect(tempDir).toBe('tmp');\n",
    );

    expect(findTestingHelperImportViolations(root)).toEqual([]);
  });
});
