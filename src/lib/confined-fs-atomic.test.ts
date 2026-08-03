import { afterEach, describe, expect, it } from 'vitest';
import {
  constants,
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { link, open } from 'node:fs/promises';
import { join } from 'node:path';
import { cleanupTempDir, createTempDir } from '#testing/helpers/temp-dir.js';
import {
  confinedAtomicWriteFile,
  confinedAtomicWriteFileForTest,
  type ConfigRevision,
  type ConfinedAtomicWriteTestOperations,
} from './confined-fs.js';

const itUnix = process.platform === 'win32' ? it.skip : it;
const tmpDirs: string[] = [];

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) cleanupTempDir(dir);
});

function createAtomicTempDir(prefix: string): string {
  const dir = realpathSync(createTempDir(prefix));
  tmpDirs.push(dir);
  return dir;
}

function makeFile(content = 'original bytes'): {
  dir: string;
  path: string;
  revision: ConfigRevision;
} {
  const dir = createAtomicTempDir('confined-atomic-write');
  const path = join(dir, 'config.yaml');
  writeFileSync(path, content, { mode: 0o600 });
  return { dir, path, revision: revisionFor(path) };
}

function revisionFor(path: string): ConfigRevision {
  const bytes = readFileSync(path);
  const stat = statSync(path, { bigint: true });
  return {
    rawSha256: createHash('sha256').update(bytes).digest('hex'),
    fileIdentity: {
      dev: stat.dev,
      ino: stat.ino,
      size: stat.size,
      mtimeNs: stat.mtimeNs,
    },
  };
}

function temporaryFiles(dir: string): string[] {
  return readdirSync(dir).filter((entry) => entry.includes('.tmp.'));
}

function fault(message: string): Error {
  return Object.assign(new Error(message), { code: 'EIO' });
}

function faultingOperations(
  operation: 'open' | 'write' | 'fsync' | 'chmod' | 'read' | 'stat' | 'rename',
): ConfinedAtomicWriteTestOperations {
  switch (operation) {
    case 'open':
      return { open: async () => Promise.reject(fault('open failed')) };
    case 'write':
      return { write: async () => Promise.reject(fault('write failed')) };
    case 'fsync':
      return { fsync: async () => Promise.reject(fault('file fsync failed')) };
    case 'chmod':
      return { chmod: async () => Promise.reject(fault('temporary mode failed')) };
    case 'read':
      return { read: async () => Promise.reject(fault('pre-rename read failed')) };
    case 'stat':
      return {
        stat: async (handle, target) => {
          if (target === 'target') throw fault('pre-rename fstat failed');
          return handle.stat({ bigint: true });
        },
      };
    case 'rename':
      return { rename: async () => Promise.reject(fault('rename failed')) };
  }
}

describe('confinedAtomicWriteFile', () => {
  it('replaces a canonical target with the complete bytes and its observed revision', async () => {
    const { dir, revision } = makeFile();
    const nested = join(dir, 'nested');
    mkdirSync(nested);
    const path = join(nested, '..', 'config.yaml');
    const replacement = Buffer.from('new \u{1f680} bytes '.repeat(20_000));

    const result = await confinedAtomicWriteFile(path, replacement, {
      expectedRevision: revision,
      mode: 0o600,
    });

    expect(result.kind).toBe('written');
    expect(readFileSync(join(dir, 'config.yaml'))).toEqual(replacement);
    if (result.kind === 'written') {
      expect(result.revision).toEqual(revisionFor(join(dir, 'config.yaml')));
    }
    expect(temporaryFiles(dir)).toEqual([]);
  });

  itUnix(
    'keeps the final regular target owner-only even when the prior file was wider',
    async () => {
      const { path } = makeFile();
      chmodSync(path, 0o644);
      const widenedRevision = revisionFor(path);

      const result = await confinedAtomicWriteFile(path, Buffer.from('replacement'), {
        expectedRevision: widenedRevision,
        mode: 0o600,
      });

      expect(result.kind).toBe('written');
      expect(statSync(path).isFile()).toBe(true);
      expect(statSync(path).mode & 0o777).toBe(0o600);
    },
  );

  it('returns a conflict without replacing bytes changed since the expected revision', async () => {
    const { dir, path, revision } = makeFile();
    writeFileSync(path, 'external update');

    const result = await confinedAtomicWriteFile(path, Buffer.from('replacement'), {
      expectedRevision: revision,
      mode: 0o600,
    });

    expect(result).toMatchObject({ kind: 'conflict', observedRevision: revisionFor(path) });
    expect(readFileSync(path, 'utf8')).toBe('external update');
    expect(temporaryFiles(dir)).toEqual([]);
  });

  it('returns a conflict when matching bytes have a different file identity', async () => {
    const { dir, path, revision } = makeFile();
    const future = new Date(Date.now() + 10_000);
    utimesSync(path, future, future);

    const result = await confinedAtomicWriteFile(path, Buffer.from('replacement'), {
      expectedRevision: revision,
      mode: 0o600,
    });

    expect(result).toMatchObject({ kind: 'conflict', observedRevision: revisionFor(path) });
    expect(readFileSync(path, 'utf8')).toBe('original bytes');
    expect(temporaryFiles(dir)).toEqual([]);
  });

  it('creates a missing target only when absence was the expected revision', async () => {
    const dir = createAtomicTempDir('confined-atomic-first-save');
    const path = join(dir, 'config.yaml');
    const replacement = Buffer.from('version: 3\n');

    const result = await confinedAtomicWriteFile(path, replacement, {
      expectedRevision: null,
      mode: 0o600,
    });

    expect(result.kind).toBe('written');
    expect(readFileSync(path)).toEqual(replacement);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(temporaryFiles(dir)).toEqual([]);
  });

  it('returns a conflict when absence was expected but the target exists', async () => {
    const { dir, path } = makeFile();

    const result = await confinedAtomicWriteFile(path, Buffer.from('replacement'), {
      expectedRevision: null,
      mode: 0o600,
    });

    expect(result).toMatchObject({ kind: 'conflict', observedRevision: revisionFor(path) });
    expect(readFileSync(path, 'utf8')).toBe('original bytes');
    expect(temporaryFiles(dir)).toEqual([]);
  });

  it('returns a conflict when another creator wins the first-save publish race', async () => {
    const dir = createAtomicTempDir('confined-atomic-create-race');
    const path = join(dir, 'config.yaml');
    const operations: ConfinedAtomicWriteTestOperations = {
      link: async (from, to) => {
        writeFileSync(to, 'racing creator', { mode: 0o600 });
        await link(from, to);
      },
    };

    const result = await confinedAtomicWriteFileForTest(
      path,
      Buffer.from('replacement'),
      { expectedRevision: null, mode: 0o600 },
      operations,
    );

    expect(result).toMatchObject({ kind: 'conflict', observedRevision: revisionFor(path) });
    expect(readFileSync(path, 'utf8')).toBe('racing creator');
    expect(temporaryFiles(dir)).toEqual([]);
  });

  itUnix('rejects a symlink target without following or changing the linked file', async () => {
    const { dir, path, revision } = makeFile();
    const linkedTarget = join(dir, 'linked-target.yaml');
    writeFileSync(linkedTarget, 'linked original');
    const link = join(dir, 'config-link.yaml');
    symlinkSync(linkedTarget, link);

    await expect(
      confinedAtomicWriteFile(link, Buffer.from('replacement'), {
        expectedRevision: revision,
        mode: 0o600,
      }),
    ).rejects.toMatchObject({ kind: 'fs-symlink-write' });
    expect(readFileSync(linkedTarget, 'utf8')).toBe('linked original');
    expect(readFileSync(path, 'utf8')).toBe('original bytes');
  });

  itUnix('never treats a dangling symlink as expected absence', async () => {
    const dir = createAtomicTempDir('confined-atomic-dangling-link');
    const missingTarget = join(dir, 'missing.yaml');
    const linkPath = join(dir, 'config.yaml');
    symlinkSync(missingTarget, linkPath);

    await expect(
      confinedAtomicWriteFile(linkPath, Buffer.from('replacement'), {
        expectedRevision: null,
        mode: 0o600,
      }),
    ).rejects.toMatchObject({ kind: 'fs-symlink-write' });
    expect(existsSync(missingTarget)).toBe(false);
    expect(temporaryFiles(dir)).toEqual([]);
  });

  itUnix(
    'rejects a symlinked parent without changing the external target or creating a temp file',
    async () => {
      const project = createAtomicTempDir('confined-atomic-project');
      const outside = createAtomicTempDir('confined-atomic-outside');
      const parent = join(project, '.splitbrief');
      const externalTarget = join(outside, 'config.yaml');
      writeFileSync(externalTarget, 'outside original');
      symlinkSync(outside, parent);

      await expect(
        confinedAtomicWriteFile(join(parent, 'config.yaml'), Buffer.from('escaped replacement'), {
          expectedRevision: revisionFor(externalTarget),
          mode: 0o600,
        }),
      ).rejects.toMatchObject({ kind: 'fs-symlink-write' });

      expect(readFileSync(externalTarget, 'utf8')).toBe('outside original');
      expect(temporaryFiles(project)).toEqual([]);
      expect(temporaryFiles(outside)).toEqual([]);
    },
  );

  it('opens target and temporary files with no-follow protection, and creates the temp exclusively', async () => {
    const { dir, path, revision } = makeFile();
    const opened: Array<Readonly<{ path: string; flags: number }>> = [];
    const operations: ConfinedAtomicWriteTestOperations = {
      open: async (openPath, flags, mode) => {
        opened.push({ path: openPath, flags });
        return open(openPath, flags, mode);
      },
    };

    const result = await confinedAtomicWriteFileForTest(
      path,
      Buffer.from('replacement'),
      { expectedRevision: revision, mode: 0o600 },
      operations,
    );

    expect(result.kind).toBe('written');
    const targetOpens = opened.filter((entry) => entry.path === path);
    const temporary = opened.find((entry) => entry.path.includes('.tmp.'));
    expect(targetOpens.some((entry) => (entry.flags & constants.O_NOFOLLOW) !== 0)).toBe(true);
    expect(temporary).toBeDefined();
    if (!temporary) throw new Error('Expected the atomic temporary file to be opened');
    expect(temporary.flags & constants.O_NOFOLLOW).toBe(constants.O_NOFOLLOW);
    expect(temporary.flags & constants.O_EXCL).toBe(constants.O_EXCL);
    expect(temporaryFiles(dir)).toEqual([]);
  });

  it.each([
    'open',
    'write',
    'fsync',
    'chmod',
    'read',
    'stat',
    'rename',
  ] as const)('preserves the original bytes when %s fails before rename', async (operation) => {
    const { dir, path, revision } = makeFile();

    await expect(
      confinedAtomicWriteFileForTest(
        path,
        Buffer.from('replacement'),
        { expectedRevision: revision, mode: 0o600 },
        faultingOperations(operation),
      ),
    ).rejects.toThrow(`${operation === 'chmod' ? 'temporary mode' : operation} failed`);

    expect(readFileSync(path, 'utf8')).toBe('original bytes');
    expect(temporaryFiles(dir)).toEqual([]);
  });

  it('reports durability uncertainty after a successful replacement whose directory sync fails', async () => {
    const { path, revision } = makeFile();
    const replacement = Buffer.from('replacement that is already visible');
    const operations: ConfinedAtomicWriteTestOperations = {
      fsync: async (handle, target) => {
        if (target === 'directory') throw fault('directory fsync failed');
        await handle.sync();
      },
    };

    const result = await confinedAtomicWriteFileForTest(
      path,
      replacement,
      { expectedRevision: revision, mode: 0o600 },
      operations,
    );

    expect(result.kind).toBe('durability-uncertain');
    expect(readFileSync(path)).toEqual(replacement);
    if (result.kind === 'durability-uncertain') {
      expect(result.observedRevision).toEqual(revisionFor(path));
      expect(result.observedRevision.rawSha256).toBe(
        createHash('sha256').update(replacement).digest('hex'),
      );
    }
  });

  it('writes every byte when the filesystem accepts partial writes', async () => {
    const { path, revision } = makeFile();
    const replacement = Buffer.from('partial-write-safe '.repeat(10_000));
    const operations: ConfinedAtomicWriteTestOperations = {
      write: async (handle, bytes, offset, length, position) => {
        const result = await handle.write(bytes, offset, Math.min(length, 17), position);
        return { bytesWritten: result.bytesWritten };
      },
    };

    const result = await confinedAtomicWriteFileForTest(
      path,
      replacement,
      { expectedRevision: revision, mode: 0o600 },
      operations,
    );

    expect(result.kind).toBe('written');
    expect(readFileSync(path)).toEqual(replacement);
  });

  it('does not create a target before a failed replacement can be committed', async () => {
    const dir = createAtomicTempDir('confined-atomic-missing');
    const path = join(dir, 'absent.yaml');
    const expectedRevision: ConfigRevision = {
      rawSha256: '0'.repeat(64),
      fileIdentity: { dev: 0n, ino: 0n, size: 0n, mtimeNs: 0n },
    };

    const result = await confinedAtomicWriteFile(path, Buffer.from('replacement'), {
      expectedRevision,
      mode: 0o600,
    });

    expect(result).toEqual({ kind: 'conflict', observedRevision: null });
    expect(existsSync(path)).toBe(false);
    expect(temporaryFiles(dir)).toEqual([]);
  });
});
