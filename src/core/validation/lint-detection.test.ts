import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { detectLintCommand } from './lint-detection.js';

describe('detectLintCommand', () => {
  let tmpDir: string;
  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'lint-detect-'));
  });
  afterEach(() => {
    rmSync(tmpDir, { recursive: true });
  });

  it.each([
    'eslint.config.js',
    'eslint.config.mjs',
    'eslint.config.cjs',
    'eslint.config.ts',
    'eslint.config.mts',
    'eslint.config.cts',
    '.eslintrc',
    '.eslintrc.js',
    '.eslintrc.cjs',
    '.eslintrc.json',
    '.eslintrc.yml',
    '.eslintrc.yaml',
  ])('resolves npx eslint when %s exists', (file) => {
    writeFileSync(join(tmpDir, file), '');
    expect(detectLintCommand(tmpDir)).toBe('npx eslint .');
  });

  it.each(['biome.json', 'biome.jsonc'])('resolves biome check when %s exists', (file) => {
    writeFileSync(join(tmpDir, file), '{}');
    expect(detectLintCommand(tmpDir)).toBe('npx biome check .');
  });

  it('prefers ESLint when both configs exist', () => {
    writeFileSync(join(tmpDir, '.eslintrc.json'), '{}');
    writeFileSync(join(tmpDir, 'biome.json'), '{}');
    expect(detectLintCommand(tmpDir)).toBe('npx eslint .');
  });

  it('returns null without any linter config', () => {
    expect(detectLintCommand(tmpDir)).toBeNull();
  });

  it('resolves npm run lint when package.json declares a recognized lint script', () => {
    writeFileSync(join(tmpDir, 'package.json'), '{"scripts":{"lint":"eslint --cache ."}}');
    expect(detectLintCommand(tmpDir)).toBe('npm run lint');
  });

  it('prefers a recognized lint package script over linter config files', () => {
    writeFileSync(join(tmpDir, 'package.json'), '{"scripts":{"lint":"eslint --cache ."}}');
    writeFileSync(join(tmpDir, '.eslintrc.json'), '{}');
    writeFileSync(join(tmpDir, 'biome.json'), '{}');
    expect(detectLintCommand(tmpDir)).toBe('npm run lint');
  });

  it('ignores an arbitrary lint script and falls through to config detection', () => {
    writeFileSync(join(tmpDir, 'package.json'), '{"scripts":{"lint":"echo lint-ok"}}');
    writeFileSync(join(tmpDir, 'biome.json'), '{}');
    expect(detectLintCommand(tmpDir)).toBe('npx biome check .');
  });

  it.each(['eslint . --fix', 'biome check --write .', 'biome check --apply-unsafe .'])(
    'ignores the rewriting lint script %s and falls through to config detection',
    (script) => {
      writeFileSync(join(tmpDir, 'package.json'), JSON.stringify({ scripts: { lint: script } }));
      writeFileSync(join(tmpDir, 'biome.json'), '{}');
      expect(detectLintCommand(tmpDir)).toBe('npx biome check .');
    },
  );

  it('ignores a blank lint script and falls through to config detection', () => {
    writeFileSync(join(tmpDir, 'package.json'), '{"scripts":{"lint":"   "}}');
    writeFileSync(join(tmpDir, 'biome.json'), '{}');
    expect(detectLintCommand(tmpDir)).toBe('npx biome check .');
  });

  it('ignores a non-string lint script', () => {
    writeFileSync(join(tmpDir, 'package.json'), '{"scripts":{"lint":42}}');
    expect(detectLintCommand(tmpDir)).toBeNull();
  });

  it('ignores malformed package.json and falls through to config detection', () => {
    writeFileSync(join(tmpDir, 'package.json'), '{not json');
    writeFileSync(join(tmpDir, '.eslintrc.json'), '{}');
    expect(detectLintCommand(tmpDir)).toBe('npx eslint .');
  });

  it('reports the real e2e regression: scripts-only project with eslint resolves npm run lint', () => {
    writeFileSync(
      join(tmpDir, 'package.json'),
      JSON.stringify({
        name: 'e2e-app',
        scripts: { test: 'vitest run', typecheck: 'tsc --noEmit', lint: 'eslint .' },
        devDependencies: { typescript: '^5.6.0', vitest: '^2.1.0' },
      }),
    );
    expect(detectLintCommand(tmpDir)).toBe('npm run lint');
  });
});
