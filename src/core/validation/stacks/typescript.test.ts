import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cleanupTempDir, createTempDir } from '#testing/helpers/temp-dir.js';
import { hasTypescriptDependency, typescriptStack } from './typescript.js';

describe('typescriptStack', () => {
  let dir: string;
  beforeEach(() => {
    dir = createTempDir('stack-ts');
  });
  afterEach(() => {
    cleanupTempDir(dir);
  });

  function writePackageJson(pkg: Record<string, unknown>): void {
    writeFileSync(join(dir, 'package.json'), JSON.stringify(pkg));
  }

  it('typescript: package.json without scripts.test yields null test command', () => {
    writePackageJson({ name: 'x' });
    expect(typescriptStack.test(dir)).toBeNull();
  });

  it('scripts.test selects npm test', () => {
    writePackageJson({ scripts: { test: 'vitest run' } });
    expect(typescriptStack.test(dir)).toBe('npm test');
  });

  it('typecheck is npx tsc --noEmit', () => {
    expect(typescriptStack.typecheck(dir)).toBe('npx tsc --noEmit');
  });

  it('lint follows detectLintCommand', () => {
    expect(typescriptStack.lint(dir)).toBeNull();
    writeFileSync(join(dir, 'biome.json'), '{}');
    expect(typescriptStack.lint(dir)).toBe('npx biome check .');
  });

  it('the predicate marker admits a typescript devDependency', () => {
    writePackageJson({ devDependencies: { typescript: '^6.0.0' } });
    expect(hasTypescriptDependency(dir)).toBe(true);
  });

  it('the predicate marker rejects a package.json without typescript', () => {
    writePackageJson({ dependencies: { zod: '^4.0.0' } });
    expect(hasTypescriptDependency(dir)).toBe(false);
  });

  it('declares tsconfig.json first and the documented test patterns', () => {
    expect(typescriptStack.markers[0]).toBe('tsconfig.json');
    expect(typescriptStack.testFilePatterns).toEqual([
      '*.test.ts',
      '*.test.tsx',
      '*.spec.ts',
      '__tests__/*.ts',
    ]);
    expect(typescriptStack.narrowing).toEqual({ kind: 'path-arg', separator: '--' });
  });
});
