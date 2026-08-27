import { copyFileSync, existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, it, expect } from 'vitest';
import { buildRepoMap, MAX_FILE_SIZE_BYTES } from './repomap.js';
import { initParser } from './parse.js';
import { createTempDir, cleanupTempDir } from '#testing/helpers/temp-dir.js';

describe('buildRepoMap', () => {
  let projectDir: string;

  beforeAll(async () => {
    await initParser();
    projectDir = createTempDir('repomap-test');
    const fixtureSrc = join(
      import.meta.dirname,
      '../../../testing/fixtures/codebase/sample-project',
    );
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
    const generous = await buildRepoMap(projectDir, { tokenBudget: 5000 });
    const tight = await buildRepoMap(projectDir, { tokenBudget: 30 });
    const fileHeaderCount = (out: string) => (out.match(/^[\w.-]+\.ts:/gm) ?? []).length;
    expect(fileHeaderCount(tight)).toBeGreaterThan(0);
    expect(fileHeaderCount(tight)).toBeLessThan(fileHeaderCount(generous));
    expect(tight).toContain('d.ts:');
  });

  it('featureText mentioning a file moves that file earlier in the map', async () => {
    const baseline = await buildRepoMap(projectDir, { tokenBudget: 5000 });
    const withFeature = await buildRepoMap(projectDir, {
      tokenBudget: 5000,
      featureText: 'please change a.ts',
    });
    const headerOrder = (out: string) =>
      (out.match(/^[\w.-]+\.ts:/gm) ?? []).map((line) => line.replace(':', ''));
    const baselinePos = headerOrder(baseline).indexOf('a.ts');
    const featurePos = headerOrder(withFeature).indexOf('a.ts');
    expect(baselinePos).toBeGreaterThan(0);
    expect(featurePos).toBeLessThan(baselinePos);
  });

  it('focusFiles bias the ranking', async () => {
    const baseline = await buildRepoMap(projectDir, { tokenBudget: 5000 });
    const focused = await buildRepoMap(projectDir, { tokenBudget: 5000, focusFiles: ['a.ts'] });
    const headerOrder = (out: string) =>
      (out.match(/^[\w.-]+\.ts:/gm) ?? []).map((line) => line.replace(':', ''));
    const baselinePos = headerOrder(baseline).indexOf('a.ts');
    const focusedPos = headerOrder(focused).indexOf('a.ts');
    expect(baselinePos).toBeGreaterThan(0);
    expect(focusedPos).toBe(1);
    expect(focusedPos).toBeLessThan(baselinePos);
  });

  it('uses custom cacheDir for the SQLite cache', async () => {
    const dir = createTempDir('repomap-cache-dir');
    try {
      writeFileSync(join(dir, 'entry.ts'), 'export function entry() { return "ok"; }');

      await buildRepoMap(dir, { tokenBudget: 5000, cacheDir: '.custom-cache' });

      expect(existsSync(join(dir, '.custom-cache', 'repomap.sqlite'))).toBe(true);
      expect(existsSync(join(dir, '.splitbrief'))).toBe(false);
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
      mkdirSync(join(dir, '.splitbrief'), { recursive: true });
      writeFileSync(join(dir, '.splitbrief', 'repomap.sqlite'), 'torn header garbage'.repeat(16));

      const warnings: string[] = [];
      const out = await buildRepoMap(dir, {
        tokenBudget: 5000,
        onWarn: (m) => warnings.push(m),
      });

      expect(out).toContain('entry.ts:');
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain('corrupt');
      expect(existsSync(join(dir, '.splitbrief', 'repomap.sqlite'))).toBe(true);
    } finally {
      cleanupTempDir(dir);
    }
  });
});
