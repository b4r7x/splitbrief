import { describe, it, expect, afterEach, test } from 'vitest';
import {
  writeFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  symlinkSync,
} from 'node:fs';
import { join } from 'node:path';
import {
  readFileOrEmpty,
  checkConfigPermissions,
  writeSecureFile,
  ensureSecureDir,
  ensureGitignore,
  fsError,
} from './fs.js';
import { createTempDir, cleanupTempDir } from '#testing/helpers/temp-dir.js';

let tmp: string;

function makeTmp(): string {
  tmp = createTempDir('fs-test');
  return tmp;
}

afterEach(() => {
  if (tmp) cleanupTempDir(tmp);
});

describe('readFileOrEmpty', () => {
  it('returns content when file exists', async () => {
    const dir = makeTmp();
    const file = join(dir, 'hello.txt');
    writeFileSync(file, 'hello world', 'utf-8');
    expect(await readFileOrEmpty(file)).toBe('hello world');
  });

  it('returns empty string when file does not exist', async () => {
    const dir = makeTmp();
    expect(await readFileOrEmpty(join(dir, 'nope.txt'))).toBe('');
  });

  it('rethrows non-ENOENT read errors', async () => {
    const dir = makeTmp();
    await expect(readFileOrEmpty(dir)).rejects.toThrow();
  });
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

  it('overwrites existing file content (idempotent on same path)', () => {
    const dir = makeTmp();
    const file = join(dir, 'overwrite.txt');
    writeSecureFile(file, 'first');
    writeSecureFile(file, 'second');
    expect(readFileSync(file, 'utf-8')).toBe('second');
  });

  it('preserves 0o600 after overwrite when original was owner-only', () => {
    const dir = makeTmp();
    const file = join(dir, 'overwrite-perms.txt');
    writeSecureFile(file, 'first');
    writeSecureFile(file, 'second');
    const perms = statSync(file).mode & 0o777;
    expect(perms).toBe(0o600);
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

  it('concurrent writes to distinct files in the same new directory both succeed', async () => {
    const dir = makeTmp();
    const base = join(dir, 'concurrent');
    const files = Array.from({ length: 8 }, (_, i) => join(base, `f${i}.txt`));
    await Promise.all(
      files.map(
        (f, i) =>
          new Promise<void>(resolve => {
            writeSecureFile(f, `value-${i}`);
            resolve();
          }),
      ),
    );
    for (let i = 0; i < files.length; i++) {
      const path = files[i]!;
      expect(readFileSync(path, 'utf-8')).toBe(`value-${i}`);
      expect(statSync(path).mode & 0o777).toBe(0o600);
    }
    expect(statSync(base).mode & 0o777).toBe(0o700);
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

describe('fsError factories', () => {
  test.each([
    {
      label: 'session-id',
      id: 'bad/value',
      reason: undefined,
      message: "Invalid session-id 'bad/value'",
    },
    {
      label: 'filename',
      id: '../traversal',
      reason: "must not contain '..', '/' or '\\'",
      message: "Invalid filename '../traversal': must not contain '..', '/' or '\\'",
    },
  ])('invalidId formats $label failures', ({ label, id, reason, message }) => {
    const err = fsError.invalidId(label, id, reason);

    expect(err).toMatchObject({
      kind: 'fs-invalid-id',
      message,
      data: { label, id, reason },
    });
  });
});

describe('fsError.isInvalidId predicate', () => {
  test('matches invalidId output', () => {
    expect(fsError.isInvalidId(fsError.invalidId('x', 'y'))).toBe(true);
    expect(fsError.isInvalidId(fsError.invalidId('x', 'y', 'reason'))).toBe(true);
  });

  test('rejects non-matching values', () => {
    expect(fsError.isInvalidId(new Error('plain'))).toBe(false);
    expect(fsError.isInvalidId(null)).toBe(false);
    expect(fsError.isInvalidId({ kind: 'fs-invalid-id' })).toBe(false);
  });
});

describe('ensureGitignore', () => {
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
    const lines = content.split('\n').filter(l => l.trim() === '.diptych/');
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
});
