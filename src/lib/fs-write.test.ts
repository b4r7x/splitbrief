import { describe, it, expect, afterEach } from 'vitest';
import {
  writeFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  symlinkSync,
} from 'node:fs';
import { join } from 'node:path';
import {
  checkConfigPermissions,
  writeSecureFile,
  writeSecureFileAsync,
  writeConfinedSecureFileAsync,
  ensureSecureDir,
  ensureGitignore,
  rejectSymlinkTarget,
  rejectSymlinkTargetAsync,
  fsError,
} from './fs.js';
import { createTempDir, cleanupTempDir } from '#testing/helpers/temp-dir.js';

let tmp: string;
function makeTmp(): string {
  tmp = createTempDir('fs-write-test');
  return tmp;
}
afterEach(() => {
  if (tmp) cleanupTempDir(tmp);
});

describe('checkConfigPermissions', () => {
  it.each([
    { mode: 0o600, expected: true },
    { mode: 0o644, expected: true },
    { mode: 0o666, expected: false },
    { mode: 0o700, expected: true },
    { mode: 0o602, expected: false },
  ])('returns $expected for file mode $mode', ({ mode, expected }) => {
    const dir = makeTmp();
    const file = join(dir, `mode-${mode.toString(8)}.yaml`);
    writeFileSync(file, 'key: value');
    chmodSync(file, mode);
    expect(checkConfigPermissions(file)).toBe(expected);
  });

  it('returns false when file does not exist', () => {
    const dir = makeTmp();
    expect(checkConfigPermissions(join(dir, 'missing.yaml'))).toBe(false);
  });
});

describe('writeSecureFile', () => {
  it('writes the file contents and makes them readable', () => {
    const dir = makeTmp();
    const file = join(dir, 'sub', 'secret.txt');
    writeSecureFile(file, 'hello secret');
    expect(readFileSync(file, 'utf-8')).toBe('hello secret');
  });

  it('creates any missing parent directories', () => {
    const dir = makeTmp();
    const file = join(dir, 'a', 'b', 'c', 'deep.txt');
    writeSecureFile(file, 'deep');
    expect(existsSync(file)).toBe(true);
    expect(readFileSync(file, 'utf-8')).toBe('deep');
  });

  it('writes a new file with 0o600 permissions (owner-only)', () => {
    const dir = makeTmp();
    const file = join(dir, 'fresh.yaml');
    writeSecureFile(file, 'content');
    const perms = statSync(file).mode & 0o777;
    expect(perms).toBe(0o600);
    expect(checkConfigPermissions(file)).toBe(true);
  });

  it('creates intermediate directories with 0o700 permissions (owner-only)', () => {
    const dir = makeTmp();
    const nested = join(dir, 'nested-dir');
    writeSecureFile(join(nested, 'x.txt'), 'x');
    const dirPerms = statSync(nested).mode & 0o777;
    expect(dirPerms).toBe(0o700);
  });

  it('writes distinct sibling files under a new parent with secure modes', () => {
    const dir = makeTmp();
    const parent = join(dir, 'new-parent');
    const files = [
      { path: join(parent, 'first.txt'), content: 'first payload' },
      { path: join(parent, 'second.txt'), content: 'second payload' },
      { path: join(parent, 'third.txt'), content: 'third payload' },
    ];

    for (const file of files) writeSecureFile(file.path, file.content);

    expect(statSync(parent).mode & 0o777).toBe(0o700);
    for (const file of files) {
      expect(readFileSync(file.path, 'utf-8')).toBe(file.content);
      expect(statSync(file.path).mode & 0o777).toBe(0o600);
    }
  });

  it('overwrites existing file content (idempotent on same path)', () => {
    const dir = makeTmp();
    const file = join(dir, 'overwrite.txt');
    writeSecureFile(file, 'first');
    writeSecureFile(file, 'second');
    expect(readFileSync(file, 'utf-8')).toBe('second');
    expect(statSync(file).mode & 0o777).toBe(0o600);
  });

  it('chmods existing files to 0o600 when overwriting wider permissions', () => {
    const dir = makeTmp();
    const file = join(dir, 'widened.txt');
    writeFileSync(file, 'orig', { mode: 0o666 });
    writeSecureFile(file, 'replaced');
    expect(readFileSync(file, 'utf-8')).toBe('replaced');
    expect(statSync(file).mode & 0o777).toBe(0o600);
  });

  it('writes an empty string successfully', () => {
    const dir = makeTmp();
    const file = join(dir, 'empty.txt');
    writeSecureFile(file, '');
    expect(readFileSync(file, 'utf-8')).toBe('');
    expect(existsSync(file)).toBe(true);
  });

  it('supports multi-byte UTF-8 content round-trip', () => {
    const dir = makeTmp();
    const file = join(dir, 'utf8.txt');
    const payload = 'żółć — 日本語 — 🚀';
    writeSecureFile(file, payload);
    expect(readFileSync(file, 'utf-8')).toBe(payload);
  });

  it('throws when the target parent exists as a regular file (cannot be a directory)', () => {
    const dir = makeTmp();
    const blocker = join(dir, 'blocker');
    writeFileSync(blocker, 'i am a file');
    expect(() => writeSecureFile(join(blocker, 'child.txt'), 'x')).toThrow();
  });

  it('follows a directory symlink and writes to its target', () => {
    const dir = makeTmp();
    const real = join(dir, 'real');
    mkdirSync(real);
    const link = join(dir, 'link');
    symlinkSync(real, link);
    const file = join(link, 'through-link.txt');
    writeSecureFile(file, 'via symlink');
    expect(readFileSync(join(real, 'through-link.txt'), 'utf-8')).toBe('via symlink');
  });

  it('refuses to write through a file symlink pointing outside the directory', () => {
    const dir = makeTmp();
    const outside = join(dir, 'outside');
    mkdirSync(outside);
    const outsideFile = join(outside, 'target.txt');
    writeFileSync(outsideFile, 'original');
    const link = join(dir, 'link.txt');
    symlinkSync(outsideFile, link);

    expect(() => writeSecureFile(link, 'malicious')).toThrow(/refusing to write through symlink/);
    expect(readFileSync(outsideFile, 'utf-8')).toBe('original');
  });

  it('refuses to write through a file symlink even when target is in same directory', () => {
    const dir = makeTmp();
    const realFile = join(dir, 'real.txt');
    writeFileSync(realFile, 'original');
    const link = join(dir, 'link.txt');
    symlinkSync(realFile, link);

    expect(() => writeSecureFile(link, 'overwrite')).toThrow(/refusing to write through symlink/);
    expect(readFileSync(realFile, 'utf-8')).toBe('original');
  });

  it('removes the temp file when the rename fails (target is a non-empty directory)', () => {
    const dir = makeTmp();
    const target = join(dir, 'target');
    mkdirSync(target);
    writeFileSync(join(target, 'child.txt'), 'occupied');

    expect(() => writeSecureFile(target, 'payload')).toThrow();
    const stray = readdirSync(dir).filter((f) => f.includes('.tmp.'));
    expect(stray).toEqual([]);
  });
});

describe('writeSecureFileAsync', () => {
  it('writes content with 0o600 permissions and creates parent dirs', async () => {
    const dir = makeTmp();
    const file = join(dir, 'a', 'b', 'secret.json');
    await writeSecureFileAsync(file, '{"ok":true}');
    expect(readFileSync(file, 'utf-8')).toBe('{"ok":true}');
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(statSync(join(dir, 'a')).mode & 0o777).toBe(0o700);
  });

  it('overwrites an existing file via atomic rename', async () => {
    const dir = makeTmp();
    const file = join(dir, 'x.json');
    await writeSecureFileAsync(file, 'first');
    await writeSecureFileAsync(file, 'second');
    expect(readFileSync(file, 'utf-8')).toBe('second');
    const stray = readdirSync(dir).filter((f) => f.includes('.tmp.'));
    expect(stray).toEqual([]);
  });

  it('refuses to write through a file symlink', async () => {
    const dir = makeTmp();
    const outside = join(dir, 'outside');
    mkdirSync(outside);
    const target = join(outside, 'target.txt');
    writeFileSync(target, 'original');
    const link = join(dir, 'link.json');
    symlinkSync(target, link);

    await expect(writeSecureFileAsync(link, 'malicious')).rejects.toThrow(
      /refusing to write through symlink/,
    );
    expect(readFileSync(target, 'utf-8')).toBe('original');
  });

  it('removes the temp file when the rename fails (target is a non-empty directory)', async () => {
    const dir = makeTmp();
    const target = join(dir, 'target');
    mkdirSync(target);
    writeFileSync(join(target, 'child.txt'), 'occupied');

    await expect(writeSecureFileAsync(target, 'payload')).rejects.toThrow();
    const stray = readdirSync(dir).filter((f) => f.includes('.tmp.'));
    expect(stray).toEqual([]);
  });
});

describe('rejectSymlinkTarget', () => {
  const itUnix = process.platform === 'win32' ? it.skip : it;

  it('does nothing for a missing path', () => {
    const dir = makeTmp();
    expect(() => rejectSymlinkTarget(join(dir, 'absent.txt'))).not.toThrow();
  });

  it('does nothing for a regular file', () => {
    const dir = makeTmp();
    const file = join(dir, 'regular.txt');
    writeFileSync(file, 'content');
    expect(() => rejectSymlinkTarget(file)).not.toThrow();
  });

  itUnix('throws fs-symlink-write for a symlink target', () => {
    const dir = makeTmp();
    const target = join(dir, 'target.txt');
    writeFileSync(target, 'data');
    const link = join(dir, 'link.txt');
    symlinkSync(target, link);
    expect(() => rejectSymlinkTarget(link)).toThrow(/refusing to write through symlink/);
    let thrown: unknown;
    try {
      rejectSymlinkTarget(link);
    } catch (err) {
      thrown = err;
    }
    expect(fsError.isSymlinkWrite(thrown)).toBe(true);
  });
});

describe('rejectSymlinkTargetAsync', () => {
  const itUnix = process.platform === 'win32' ? it.skip : it;

  it('does nothing for a missing path', async () => {
    const dir = makeTmp();
    await expect(rejectSymlinkTargetAsync(join(dir, 'absent.txt'))).resolves.toBeUndefined();
  });

  itUnix('throws fs-symlink-write for a symlink target', async () => {
    const dir = makeTmp();
    const target = join(dir, 'target.txt');
    writeFileSync(target, 'data');
    const link = join(dir, 'link.txt');
    symlinkSync(target, link);
    await expect(rejectSymlinkTargetAsync(link)).rejects.toMatchObject({
      kind: 'fs-symlink-write',
    });
  });
});

describe('writeConfinedSecureFileAsync', () => {
  it('writes content under the root with 0o600 permissions', async () => {
    const dir = makeTmp();
    await writeConfinedSecureFileAsync(dir, join('meta', 'cache.json'), '{"ok":true}');
    expect(readFileSync(join(dir, 'meta', 'cache.json'), 'utf-8')).toBe('{"ok":true}');
    expect(statSync(join(dir, 'meta', 'cache.json')).mode & 0o777).toBe(0o600);
  });

  it('rejects an absolute relative path', async () => {
    const dir = makeTmp();
    await expect(writeConfinedSecureFileAsync(dir, '/etc/passwd', 'x')).rejects.toMatchObject({
      kind: 'path-confined-absolute',
    });
  });

  it('rejects a traversal relative path', async () => {
    const dir = makeTmp();
    await expect(
      writeConfinedSecureFileAsync(dir, join('..', 'escape.json'), 'x'),
    ).rejects.toMatchObject({ kind: 'path-confined-escape' });
  });

  it('refuses to write when a parent directory is a symlink pointing outside the root', async () => {
    const dir = makeTmp();
    const outside = join(dir, 'outside');
    mkdirSync(outside);
    const root = join(dir, 'root');
    mkdirSync(root);
    // root/meta -> ../outside (parent of the target resolves outside the root)
    symlinkSync(outside, join(root, 'meta'));

    await expect(
      writeConfinedSecureFileAsync(root, join('meta', 'cache.json'), 'SECRET'),
    ).rejects.toMatchObject({ kind: 'path-confined-escape' });
    expect(existsSync(join(outside, 'cache.json'))).toBe(false);
  });
});

describe('ensureSecureDir', () => {
  it('creates a directory that did not exist with 0o700 permissions', () => {
    const dir = makeTmp();
    const target = join(dir, 'new-secure');
    ensureSecureDir(target);
    expect(existsSync(target)).toBe(true);
    expect(statSync(target).mode & 0o777).toBe(0o700);
  });

  it('is a no-op on an existing directory (does not throw)', () => {
    const dir = makeTmp();
    ensureSecureDir(dir);
    expect(() => ensureSecureDir(dir)).not.toThrow();
  });

  it('creates nested missing ancestors recursively', () => {
    const dir = makeTmp();
    const target = join(dir, 'a', 'b', 'c');
    ensureSecureDir(target);
    expect(existsSync(target)).toBe(true);
  });
});

describe('ensureGitignore', () => {
  const itUnix = process.platform === 'win32' ? it.skip : it;

  it('creates .gitignore with entry when file does not exist', () => {
    const dir = makeTmp();
    ensureGitignore(dir, '.diptych/');
    const content = readFileSync(join(dir, '.gitignore'), 'utf-8');
    expect(content).toBe('.diptych/\n');
  });

  it('appends entry to existing .gitignore', () => {
    const dir = makeTmp();
    writeFileSync(join(dir, '.gitignore'), 'node_modules/\n');
    ensureGitignore(dir, '.diptych/');
    const content = readFileSync(join(dir, '.gitignore'), 'utf-8');
    expect(content).toContain('node_modules/');
    expect(content).toContain('.diptych/');
  });

  it('does not duplicate entry if already present', () => {
    const dir = makeTmp();
    writeFileSync(join(dir, '.gitignore'), '.diptych/\n');
    ensureGitignore(dir, '.diptych/');
    const content = readFileSync(join(dir, '.gitignore'), 'utf-8');
    const lines = content.split('\n').filter((l) => l.trim() === '.diptych/');
    expect(lines).toHaveLength(1);
  });

  it('does not produce double blank lines when file lacks trailing newline', () => {
    const dir = makeTmp();
    writeFileSync(join(dir, '.gitignore'), 'node_modules/');
    ensureGitignore(dir, '.diptych/');
    const content = readFileSync(join(dir, '.gitignore'), 'utf-8');
    expect(content).not.toContain('\n\n');
    expect(content).toContain('.diptych/');
  });

  itUnix('refuses a final symlink without changing its external target', () => {
    const dir = makeTmp();
    const outside = createTempDir('fs-gitignore-outside');
    const sentinel = join(outside, '.gitignore');
    try {
      writeFileSync(sentinel, 'external sentinel\n');
      symlinkSync(sentinel, join(dir, '.gitignore'));

      expect(() => ensureGitignore(dir, '.diptych/')).toThrow(/refusing to write through symlink/);
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

      expect(() => ensureGitignore(dir, '.diptych/')).toThrow(/refusing to write through symlink/);
      expect(existsSync(target)).toBe(false);
    } finally {
      cleanupTempDir(outside);
    }
  });
});
