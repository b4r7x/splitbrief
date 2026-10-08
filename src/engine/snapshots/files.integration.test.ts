import { createHash } from 'node:crypto';
import { chmod, mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { type Dirent, symlinkSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { simpleGit } from 'simple-git';
import { collectTrackedFiles, hashFile, walkProjectEntries } from './files.js';

const readdir = vi.hoisted(() =>
  vi.fn<(path: string, options: { withFileTypes: true; encoding: 'utf8' }) => Promise<Dirent[]>>(),
);

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, readdir: readdir.mockImplementation(actual.readdir) };
});

function fakeDirent(name: string, kind: 'file' | 'dir'): Dirent {
  return {
    name,
    parentPath: '',
    path: '',
    isDirectory: () => kind === 'dir',
    isFile: () => kind === 'file',
    isSymbolicLink: () => false,
    isBlockDevice: () => false,
    isCharacterDevice: () => false,
    isFIFO: () => false,
    isSocket: () => false,
  };
}

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

describe('walkProjectEntries', () => {
  it('keeps symlink entries without following them and skips internal directories', async () => {
    await mkdir(join(tmp, 'src', 'node_modules'), { recursive: true });
    await mkdir(join(tmp, '.splitbrief'), { recursive: true });
    await writeFile(join(tmp, 'src', 'file.txt'), 'content');
    await writeFile(join(tmp, 'src', 'node_modules', 'ignored.txt'), 'ignored');
    await writeFile(join(tmp, '.splitbrief', 'ignored.txt'), 'ignored');
    symlinkSync('src/file.txt', join(tmp, 'file-link'));
    symlinkSync('src', join(tmp, 'directory-link'));
    symlinkSync('missing', join(tmp, 'broken-link'));
    symlinkSync('..', join(tmp, 'src', 'loop'));

    const entries = [];
    for await (const entry of walkProjectEntries(tmp)) entries.push(entry);

    expect(entries.sort((a, b) => a.path.localeCompare(b.path))).toEqual([
      { path: 'broken-link', kind: 'symlink' },
      { path: 'directory-link', kind: 'symlink' },
      { path: 'file-link', kind: 'symlink' },
      { path: 'src', kind: 'directory' },
      { path: 'src/file.txt', kind: 'file' },
      { path: 'src/loop', kind: 'symlink' },
    ]);
  });

  it('uses the source project ignore rules for files, symlinks and directories', async () => {
    await initGitRepo(tmp);
    await writeFile(join(tmp, '.gitignore'), 'ignored/\nignored-link\n*.log\n!keep.log\n');
    const workspace = join(tmp, 'workspace');
    await mkdir(join(workspace, 'ignored', 'nested'), { recursive: true });
    await mkdir(join(workspace, 'src'), { recursive: true });
    await writeFile(join(workspace, '.gitignore'), 'src/\nfile-link\n');
    await writeFile(join(workspace, 'ignored', 'nested', 'file.txt'), 'ignored');
    await writeFile(join(workspace, 'src', 'file.txt'), 'kept');
    await writeFile(join(workspace, 'debug.log'), 'ignored');
    await writeFile(join(workspace, 'keep.log'), 'kept');
    symlinkSync('src/file.txt', join(workspace, 'file-link'));
    symlinkSync('src/file.txt', join(workspace, 'ignored-link'));

    const entries = [];
    for await (const entry of walkProjectEntries(workspace, { ignoreProjectDir: tmp }))
      entries.push(entry);

    expect(entries.sort((a, b) => a.path.localeCompare(b.path))).toEqual([
      { path: '.gitignore', kind: 'file' },
      { path: 'file-link', kind: 'symlink' },
      { path: 'keep.log', kind: 'file' },
      { path: 'src', kind: 'directory' },
      { path: 'src/file.txt', kind: 'file' },
    ]);
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

  it('excludes .git/, .splitbrief/, and node_modules/ at any depth', async () => {
    await mkdir(join(tmp, 'packages', 'app', 'node_modules', 'foo'), { recursive: true });
    await mkdir(join(tmp, 'packages', 'app', '.git'), { recursive: true });
    await mkdir(join(tmp, 'packages', 'app', '.splitbrief'), { recursive: true });
    await writeFile(join(tmp, 'packages', 'app', 'node_modules', 'foo', 'index.js'), '');
    await writeFile(join(tmp, 'packages', 'app', '.git', 'HEAD'), 'ref: refs/heads/main\n');
    await writeFile(join(tmp, 'packages', 'app', '.splitbrief', 'state.json'), '{}');
    await writeFile(join(tmp, 'packages', 'app', 'src.ts'), 'export {}');

    const files = await collectTrackedFiles(tmp);
    expect(files).toEqual(['packages/app/src.ts']);
  });

  it('never enters a directory the project ignores', async () => {
    await initGitRepo(tmp);
    await writeFile(join(tmp, '.gitignore'), 'target/\n');
    await mkdir(join(tmp, 'target', 'deep'), { recursive: true });
    await writeFile(join(tmp, 'target', 'deep', 'artifact.bin'), '');
    await writeFile(join(tmp, 'main.rs'), 'fn main() {}');
    // Unreadable: descending into it would throw instead of being filtered later.
    await chmod(join(tmp, 'target'), 0o000);
    try {
      const files = await collectTrackedFiles(tmp);
      expect(files).toContain('main.rs');
      expect(files.some((file) => file.startsWith('target/'))).toBe(false);
    } finally {
      await chmod(join(tmp, 'target'), 0o700);
    }
  });

  it('collects a directory with more entries than one spread argument list holds', async () => {
    await initGitRepo(tmp);
    const big = Array.from({ length: 200_000 }, (_, index) => fakeDirent(`f${index}`, 'file'));
    readdir
      .mockImplementationOnce(async () => [fakeDirent('big', 'dir')])
      .mockImplementationOnce(async () => big);

    const files = await collectTrackedFiles(tmp);
    expect(files).toHaveLength(big.length);
    expect(files[0]).toBe('big/f0');
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
