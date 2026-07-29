import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { symlinkSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { simpleGit } from 'simple-git';
import { collectTrackedFiles, hashFile } from './files.js';

let tmp: string;

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), 'splitbrief-snapshot-'));
});

afterEach(async () => {
  await rm(tmp, { recursive: true, force: true });
});

async function initGitRepo(dir: string): Promise<void> {
  await simpleGit(dir).init();
}

describe('hashFile', () => {
  it('returns null for non-existent file', async () => {
    const result = await hashFile(join(tmp, 'nope.txt'));
    expect(result).toBeNull();
  });

  it('returns correct sha256 for known-content file', async () => {
    const content = 'hello world\n';
    const filePath = join(tmp, 'hello.txt');
    await writeFile(filePath, content);
    const expected = createHash('sha256').update(content).digest('hex');
    const result = await hashFile(filePath);
    expect(result).toBe(expected);
  });
});

describe('collectTrackedFiles', () => {
  it('excludes .git/, .splitbrief/, and node_modules/', async () => {
    await mkdir(join(tmp, '.git'), { recursive: true });
    await mkdir(join(tmp, '.splitbrief'), { recursive: true });
    await mkdir(join(tmp, 'node_modules', 'foo'), { recursive: true });
    await writeFile(join(tmp, '.git', 'HEAD'), 'ref: refs/heads/main\n');
    await writeFile(join(tmp, '.splitbrief', 'state.json'), '{}');
    await writeFile(join(tmp, 'node_modules', 'foo', 'index.js'), '');
    await writeFile(join(tmp, 'src.ts'), 'export {}');

    const files = await collectTrackedFiles(tmp);
    expect(files.some((f) => f.startsWith('.git/'))).toBe(false);
    expect(files.some((f) => f.startsWith('.splitbrief/'))).toBe(false);
    expect(files.some((f) => f.startsWith('node_modules/'))).toBe(false);
    expect(files).toContain('src.ts');
  });

  it('excludes paths matched by .gitignore directory patterns', async () => {
    await initGitRepo(tmp);
    await writeFile(join(tmp, '.gitignore'), 'dist/\nbuild/\n');
    await mkdir(join(tmp, 'dist'), { recursive: true });
    await mkdir(join(tmp, 'src'), { recursive: true });
    await writeFile(join(tmp, 'dist', 'bundle.js'), '');
    await writeFile(join(tmp, 'src', 'index.ts'), '');

    const files = await collectTrackedFiles(tmp);
    expect(files.some((f) => f.startsWith('dist/'))).toBe(false);
    expect(files).toContain('src/index.ts');
    expect(files).toContain('.gitignore');
  });

  it('uses git-compatible .gitignore matching for globs and negation', async () => {
    await initGitRepo(tmp);
    await writeFile(join(tmp, '.gitignore'), '*.log\ncoverage/**\n!important.log\n');
    await mkdir(join(tmp, 'coverage', 'nested'), { recursive: true });
    await writeFile(join(tmp, 'debug.log'), 'ignored');
    await writeFile(join(tmp, 'important.log'), 'kept');
    await writeFile(join(tmp, 'coverage', 'nested', 'report.json'), '{}');
    await writeFile(join(tmp, 'src.ts'), 'export {}');

    const files = await collectTrackedFiles(tmp);

    expect(files).not.toContain('debug.log');
    expect(files).not.toContain('coverage/nested/report.json');
    expect(files).toContain('important.log');
    expect(files).toContain('src.ts');
  });

  it('skips symlinked files during capture', async () => {
    const outside = await mkdtemp(join(tmpdir(), 'splitbrief-outside-'));
    try {
      writeFileSync(join(outside, 'secret.txt'), 'sensitive data');
      await writeFile(join(tmp, 'real.ts'), 'safe content');
      symlinkSync(join(outside, 'secret.txt'), join(tmp, 'linked.txt'));

      const files = await collectTrackedFiles(tmp);
      expect(files).toContain('real.ts');
      expect(files).not.toContain('linked.txt');
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  it('skips symlinked directories during capture', async () => {
    const outside = await mkdtemp(join(tmpdir(), 'splitbrief-outside-'));
    try {
      mkdirSync(join(outside, 'secrets'), { recursive: true });
      writeFileSync(join(outside, 'secrets', 'key.pem'), 'private key');
      await writeFile(join(tmp, 'real.ts'), 'safe');
      symlinkSync(join(outside, 'secrets'), join(tmp, 'linked-dir'));

      const files = await collectTrackedFiles(tmp);
      expect(files).toContain('real.ts');
      expect(files.some((f) => f.startsWith('linked-dir/'))).toBe(false);
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });
});
