import { copyFileSync, existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, it, expect } from 'vitest';
import { buildRepoMap, MAX_FILE_SIZE_BYTES } from './repomap.js';
import { initParser } from './parse.js';
import { createTempDir, cleanupTempDir } from '#testing/helpers/temp-dir.js';

describe('buildRepoMap', () => {
  let projectDir: string;

  beforeAll(async () => {
    await initParser();
    projectDir = createTempDir('repomap-test');
    const fixtureSrc = resolve('testing/fixtures/codebase/sample-project');
    for (const file of readdirSync(fixtureSrc)) {
      if (file.endsWith('.ts')) {
        copyFileSync(join(fixtureSrc, file), join(projectDir, file));
      }
    }
  });

  afterAll(() => {
    if (projectDir) cleanupTempDir(projectDir);
  });

  it('returns a non-empty string with file headers and signatures', async () => {
    const out = await buildRepoMap(projectDir, { tokenBudget: 5000 });
    expect(out).toContain('a.ts:');
    expect(out).toContain('b.ts:');
    expect(out).toContain('c.ts:');
    expect(out).toContain('d.ts:');
    expect(out).toMatch(/export function aMain\(\): string/);
  });

  it('respects tokenBudget by dropping lowest-ranked files when tight', async () => {
    const tight = await buildRepoMap(projectDir, { tokenBudget: 30 });
    expect(tight.length).toBeGreaterThan(0);
    expect(tight.length).toBeLessThan(2000);
  });

  it('focusFiles bias the ranking', async () => {
    const noFocus = await buildRepoMap(projectDir, { tokenBudget: 5000 });
    const focused = await buildRepoMap(projectDir, { tokenBudget: 5000, focusFiles: ['d.ts'] });
    const noFocusIdx = noFocus.indexOf('d.ts');
    const focusedIdx = focused.indexOf('d.ts');
    expect(focusedIdx).toBeGreaterThanOrEqual(0);
    expect(noFocusIdx).toBeGreaterThanOrEqual(0);
    expect(focusedIdx).toBeLessThanOrEqual(noFocusIdx);
  });

  it('uses custom cacheDir for the SQLite cache', async () => {
    const dir = createTempDir('repomap-cache-dir');
    try {
      writeFileSync(join(dir, 'entry.ts'), 'export function entry() { return "ok"; }');

      await buildRepoMap(dir, { tokenBudget: 5000, cacheDir: '.custom-cache' });

      expect(existsSync(join(dir, '.custom-cache', 'repomap.sqlite'))).toBe(true);
      expect(existsSync(join(dir, '.diptych'))).toBe(false);
    } finally {
      cleanupTempDir(dir);
    }
  });

  it('matches include globs against relative paths', async () => {
    const dir = createTempDir('repomap-include-globs');
    try {
      mkdirSync(join(dir, 'src', 'nested'), { recursive: true });
      writeFileSync(join(dir, 'root.ts'), 'export function rootOnly() { return "root"; }');
      writeFileSync(join(dir, 'src', 'main.ts'), 'export function srcMain() { return "src"; }');
      writeFileSync(
        join(dir, 'src', 'nested', 'feature.ts'),
        'export function nestedFeature() { return "nested"; }',
      );

      const out = await buildRepoMap(dir, { tokenBudget: 5000, include: ['src/**/*.ts'] });

      expect(out).toContain('src/main.ts:');
      expect(out).toContain('src/nested/feature.ts:');
      expect(out).not.toContain('root.ts:');
    } finally {
      cleanupTempDir(dir);
    }
  });

  it('excludes node_modules and .git directories by name', async () => {
    const dir = createTempDir('repomap-exclude-dirs');
    try {
      mkdirSync(join(dir, 'node_modules', 'pkg'), { recursive: true });
      mkdirSync(join(dir, '.git', 'objects'), { recursive: true });
      mkdirSync(join(dir, 'src'), { recursive: true });
      writeFileSync(
        join(dir, 'node_modules', 'pkg', 'index.ts'),
        'export function dep() { return "dep"; }',
      );
      writeFileSync(
        join(dir, '.git', 'objects', 'hook.ts'),
        'export function hook() { return "hook"; }',
      );
      writeFileSync(join(dir, 'src', 'app.ts'), 'export function app() { return "app"; }');

      const out = await buildRepoMap(dir, { tokenBudget: 5000 });

      expect(out).toContain('src/app.ts:');
      expect(out).not.toContain('node_modules');
      expect(out).not.toContain('.git');
    } finally {
      cleanupTempDir(dir);
    }
  });

  it('skips files larger than MAX_FILE_SIZE_BYTES', async () => {
    const dir = createTempDir('repomap-large-file');
    try {
      writeFileSync(join(dir, 'small.ts'), 'export function small() { return "ok"; }');
      writeFileSync(
        join(dir, 'huge.ts'),
        'export function huge() { return "' + 'x'.repeat(MAX_FILE_SIZE_BYTES + 1) + '"; }',
      );

      const out = await buildRepoMap(dir, { tokenBudget: 5000 });

      expect(out).toContain('small.ts:');
      expect(out).not.toContain('huge.ts:');
    } finally {
      cleanupTempDir(dir);
    }
  });

  it('merges user exclude patterns with defaults instead of replacing', async () => {
    const dir = createTempDir('repomap-merge-excludes');
    try {
      mkdirSync(join(dir, 'node_modules', 'pkg'), { recursive: true });
      mkdirSync(join(dir, 'src'), { recursive: true });
      writeFileSync(
        join(dir, 'node_modules', 'pkg', 'lib.ts'),
        'export function lib() { return "lib"; }',
      );
      writeFileSync(join(dir, 'src', 'app.ts'), 'export function app() { return "app"; }');
      writeFileSync(join(dir, 'src', 'app.test.ts'), 'import { app } from "./app.js";');
      writeFileSync(join(dir, 'src', 'gen.ts'), 'export function gen() { return "gen"; }');

      const out = await buildRepoMap(dir, { tokenBudget: 5000, exclude: ['gen\\.ts$'] });

      expect(out).toContain('src/app.ts:');
      expect(out).not.toContain('node_modules');
      expect(out).not.toContain('gen.ts');
    } finally {
      cleanupTempDir(dir);
    }
  });

  it('supports ? include globs and keeps extension-only include behavior', async () => {
    const dir = createTempDir('repomap-include-simple');
    try {
      mkdirSync(join(dir, 'src'), { recursive: true });
      writeFileSync(join(dir, 'root.ts'), 'export function rootOnly() { return "root"; }');
      writeFileSync(
        join(dir, 'src', 'service1.ts'),
        'export function serviceOne() { return "one"; }',
      );
      writeFileSync(
        join(dir, 'src', 'service10.ts'),
        'export function serviceTen() { return "ten"; }',
      );

      const questionMark = await buildRepoMap(dir, {
        tokenBudget: 5000,
        include: ['src/service?.ts'],
      });
      const extensionOnly = await buildRepoMap(dir, { tokenBudget: 5000, include: ['*.ts'] });

      expect(questionMark).toContain('src/service1.ts:');
      expect(questionMark).not.toContain('src/service10.ts:');
      expect(extensionOnly).toContain('root.ts:');
      expect(extensionOnly).toContain('src/service1.ts:');
      expect(extensionOnly).toContain('src/service10.ts:');
    } finally {
      cleanupTempDir(dir);
    }
  });

  it('recovers from a corrupt cache db, warns via onWarn, and still builds the map', async () => {
    const dir = createTempDir('repomap-corrupt-cache');
    try {
      writeFileSync(join(dir, 'entry.ts'), 'export function entry() { return "ok"; }');
      mkdirSync(join(dir, '.diptych'), { recursive: true });
      writeFileSync(join(dir, '.diptych', 'repomap.sqlite'), 'torn header garbage'.repeat(16));

      const warnings: string[] = [];
      const out = await buildRepoMap(dir, {
        tokenBudget: 5000,
        onWarn: (m) => warnings.push(m),
      });

      expect(out).toContain('entry.ts:');
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain('corrupt');
      expect(existsSync(join(dir, '.diptych', 'repomap.sqlite'))).toBe(true);
    } finally {
      cleanupTempDir(dir);
    }
  });
});
