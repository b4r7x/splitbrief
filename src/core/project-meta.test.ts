import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cleanupTempDir, createTempDir } from '#testing/helpers/temp-dir.js';
import { packageScript } from './project-meta.js';

describe('packageScript', () => {
  let dir: string;
  beforeEach(() => {
    dir = createTempDir('project-meta');
  });
  afterEach(() => {
    cleanupTempDir(dir);
  });

  function writePackageJson(pkg: Record<string, unknown>): void {
    writeFileSync(join(dir, 'package.json'), JSON.stringify(pkg));
  }

  it('returns the script body verbatim', () => {
    writePackageJson({ scripts: { lint: 'biome check .' } });
    expect(packageScript(dir, 'lint')).toBe('biome check .');
  });

  it('returns null without a package.json', () => {
    expect(packageScript(dir, 'test')).toBeNull();
  });

  it('returns null when scripts is absent or not an object', () => {
    writePackageJson({ name: 'x' });
    expect(packageScript(dir, 'test')).toBeNull();
    writePackageJson({ scripts: 'vitest run' });
    expect(packageScript(dir, 'test')).toBeNull();
  });

  it('returns null for a missing, non-string or blank script', () => {
    writePackageJson({ scripts: { build: 'tsc' } });
    expect(packageScript(dir, 'test')).toBeNull();
    writePackageJson({ scripts: { test: 42 } });
    expect(packageScript(dir, 'test')).toBeNull();
    writePackageJson({ scripts: { test: '   ' } });
    expect(packageScript(dir, 'test')).toBeNull();
  });
});
