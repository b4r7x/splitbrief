import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { cleanupTempDir, createTempDir } from '#testing/helpers/temp-dir.js';
import { readPackageScripts } from '../../../../core/readiness/repo-posture.js';
import { missingNpmScript } from './npm-scripts.js';

describe('missingNpmScript for a package.json that does not parse', () => {
  let projectDir = '';

  beforeEach(() => {
    projectDir = createTempDir('npm-scripts');
  });

  afterEach(() => {
    cleanupTempDir(projectDir);
  });

  it('says package.json was not found when the scripts carry a parse error', () => {
    expect(
      missingNpmScript('npm run x', true, {
        packageJsonExists: true,
        scripts: {},
        parseError: 'Unexpected end of JSON input',
      }),
    ).toBe('runs an npm script, but package.json was not found');
  });

  it.each(['{', '[]'])('says package.json was not found for the file %j', (content) => {
    writeFileSync(join(projectDir, 'package.json'), content);
    expect(missingNpmScript('npm run lint', true, readPackageScripts(projectDir))).toBe(
      'runs an npm script, but package.json was not found',
    );
  });
});
