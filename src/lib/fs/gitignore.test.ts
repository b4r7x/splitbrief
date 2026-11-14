import { describe, it, expect } from 'vitest';
import { writeFileSync, existsSync, readFileSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { ensureGitignore } from './gitignore.js';
import { createTempDir, cleanupTempDir } from '#testing/helpers/temp-dir.js';
import { setupScopedTempDir } from '#testing/helpers/scoped-temp-dir.js';

const makeTmp = setupScopedTempDir('fs-write-test');

describe('ensureGitignore', () => {
  const itUnix = process.platform === 'win32' ? it.skip : it;

  it.each([
    '.splitbrief/',
    '/.splitbrief/',
    '.splitbrief/*',
    '/.splitbrief/*',
    '.splitbrief/**',
    '/.splitbrief/**',
  ])('recognizes directory-content rules without defeating config exceptions', (rule) => {
    const projectDir = makeTmp();
    const ignorePath = join(projectDir, '.gitignore');
    const before = `node_modules/\n${rule}\n!.splitbrief/config.yaml\n`;
    writeFileSync(ignorePath, before);

    expect(ensureGitignore(projectDir, '.splitbrief/')).toBe(false);

    expect(readFileSync(ignorePath, 'utf8')).toBe(before);
  });

  it.each(['!.splitbrief/config.yaml', '!/.splitbrief/config.yaml', '!.splitbrief/'])(
    'inserts child coverage before an existing exception: %s',
    (exception) => {
      const projectDir = makeTmp();
      const ignorePath = join(projectDir, '.gitignore');
      writeFileSync(ignorePath, `node_modules/\n${exception}\n`);

      expect(ensureGitignore(projectDir, '.splitbrief/')).toBe(true);
      expect(ensureGitignore(projectDir, '.splitbrief/')).toBe(false);

      expect(readFileSync(ignorePath, 'utf8')).toBe(`node_modules/\n.splitbrief/*\n${exception}\n`);
    },
  );

  it('creates .gitignore with entry when file does not exist', () => {
    const dir = makeTmp();
    expect(ensureGitignore(dir, '.splitbrief/')).toBe(true);
    const content = readFileSync(join(dir, '.gitignore'), 'utf-8');
    expect(content).toBe('.splitbrief/\n');
  });

  it('appends entry to existing .gitignore', () => {
    const dir = makeTmp();
    writeFileSync(join(dir, '.gitignore'), 'node_modules/\n');
    expect(ensureGitignore(dir, '.splitbrief/')).toBe(true);
    const content = readFileSync(join(dir, '.gitignore'), 'utf-8');
    expect(content).toContain('node_modules/');
    expect(content).toContain('.splitbrief/');
  });

  it('does not duplicate entry if already present', () => {
    const dir = makeTmp();
    writeFileSync(join(dir, '.gitignore'), '.splitbrief/\n');
    expect(ensureGitignore(dir, '.splitbrief/')).toBe(false);
    const content = readFileSync(join(dir, '.gitignore'), 'utf-8');
    const lines = content.split('\n').filter((l) => l.trim() === '.splitbrief/');
    expect(lines).toHaveLength(1);
  });

  it('does not produce double blank lines when file lacks trailing newline', () => {
    const dir = makeTmp();
    writeFileSync(join(dir, '.gitignore'), 'node_modules/');
    ensureGitignore(dir, '.splitbrief/');
    const content = readFileSync(join(dir, '.gitignore'), 'utf-8');
    expect(content).not.toContain('\n\n');
    expect(content).toContain('.splitbrief/');
  });

  itUnix('refuses a final symlink without changing its external target', () => {
    const dir = makeTmp();
    const outside = createTempDir('fs-gitignore-outside');
    const sentinel = join(outside, '.gitignore');
    try {
      writeFileSync(sentinel, 'external sentinel\n');
      symlinkSync(sentinel, join(dir, '.gitignore'));

      expect(() => ensureGitignore(dir, '.splitbrief/')).toThrow(
        /refusing to write through symlink/,
      );
      expect(readFileSync(sentinel, 'utf-8')).toBe('external sentinel\n');
    } finally {
      cleanupTempDir(outside);
    }
  });

  itUnix('refuses dangling final symlinks without creating their targets', () => {
    const dir = makeTmp();
    const outside = createTempDir('fs-gitignore-dangling');
    const target = join(outside, '.gitignore');
    try {
      symlinkSync(target, join(dir, '.gitignore'));

      expect(() => ensureGitignore(dir, '.splitbrief/')).toThrow(
        /refusing to write through symlink/,
      );
      expect(existsSync(target)).toBe(false);
    } finally {
      cleanupTempDir(outside);
    }
  });
});
