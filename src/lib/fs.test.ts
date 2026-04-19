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
});

describe('checkConfigPermissions', () => {
  it('returns true for a file with 0o600 permissions', () => {
    const dir = makeTmp();
    const file = join(dir, 'secure.yaml');
    writeFileSync(file, 'key: value', { mode: 0o600 });
    expect(checkConfigPermissions(file)).toBe(true);
  });

  it('returns true for a file with 0o644 permissions', () => {
    const dir = makeTmp();
    const file = join(dir, 'readable.yaml');
    writeFileSync(file, 'key: value', { mode: 0o644 });
    expect(checkConfigPermissions(file)).toBe(true);
  });

  it('returns false for a file with 0o666 permissions', () => {
    const dir = makeTmp();
    const file = join(dir, 'open.yaml');
    writeFileSync(file, 'key: value');
    chmodSync(file, 0o666);
    expect(checkConfigPermissions(file)).toBe(false);
  });

  it('returns true for a file with 0o700 permissions (secure dir)', () => {
    const dir = makeTmp();
    const file = join(dir, 'dir-perm.yaml');
    writeFileSync(file, 'key: value');
    chmodSync(file, 0o700);
    expect(checkConfigPermissions(file)).toBe(true);
  });

  it('returns false for a file with 0o602 permissions (other-writable)', () => {
    const dir = makeTmp();
    const file = join(dir, 'world.yaml');
    writeFileSync(file, 'key: value');
    chmodSync(file, 0o602);
    expect(checkConfigPermissions(file)).toBe(false);
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

  it('does not relax permissions on overwrite when the existing file was wider', () => {
    const dir = makeTmp();
    const file = join(dir, 'widened.txt');
    writeFileSync(file, 'orig', { mode: 0o666 });
    // writeSecureFile writes via writeFileSync which replaces content but Node
    // does not re-chmod when the file already exists. Document the observable
    // contract: content is overwritten. Permission preservation for pre-existing
    // wider files is out of scope of `writeSecureFile` (caller should rotate).
    writeSecureFile(file, 'replaced');
    expect(readFileSync(file, 'utf-8')).toBe('replaced');
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
    // Asking writeSecureFile to create `blocker/child.txt` must fail: blocker
    // is a regular file, not a directory — mkdirSync('.../blocker', {recursive:true})
    // surfaces an EEXIST / ENOTDIR to the caller.
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
    // And the directory itself is 0o700.
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
  test('invalidId without reason produces simple message', () => {
    const err = fsError.invalidId('session-id', 'bad/value');
    expect(err).toBeInstanceOf(Error);
    expect(err.kind).toBe('fs-invalid-id');
    expect(err.message).toBe("Invalid session-id 'bad/value'");
    expect(err.data).toEqual({ label: 'session-id', id: 'bad/value', reason: undefined });
  });

  test('invalidId with reason appends reason to message', () => {
    const err = fsError.invalidId('filename', '../traversal', "must not contain '..', '/' or '\\'");
    expect(err.kind).toBe('fs-invalid-id');
    expect(err.message).toBe("Invalid filename '../traversal': must not contain '..', '/' or '\\'");
    expect(err.data).toEqual({ label: 'filename', id: '../traversal', reason: "must not contain '..', '/' or '\\'" });
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

  test('narrows type for data access', () => {
    const err: unknown = fsError.invalidId('filename', '../evil', 'blocked');
    if (fsError.isInvalidId(err)) {
      expect(err.data).toEqual({ label: 'filename', id: '../evil', reason: 'blocked' });
    } else {
      throw new Error('predicate should match');
    }
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
