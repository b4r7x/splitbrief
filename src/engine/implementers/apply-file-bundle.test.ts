import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  chmodSync,
  linkSync,
  mkdirSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { createTempDir, cleanupTempDir } from '#testing/helpers/temp-dir.js';
import { captureBundleBaseline } from './bundle-baseline.js';
import type { BundleBaseline } from './file-bundle.js';
import type { FileBundleCandidate } from './parse-file-bundle.js';
import { applyFileBundle } from './apply-file-bundle.js';

/**
 * Hooks around the real confined primitives: an apply can only be driven into a
 * write failure, a mid-write race or a cancellation between writes from inside
 * the write itself. Every unhooked call is the genuine primitive.
 */
type WriteHook = (path: string) => void | Promise<void>;
let beforeWrite: WriteHook | undefined;
let afterWrite: WriteHook | undefined;

vi.mock('../../lib/confined-fs.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/confined-fs.js')>();
  return {
    ...actual,
    confinedCreateFile: async (dir: string, path: string, content: string) => {
      await beforeWrite?.(path);
      await actual.confinedCreateFile(dir, path, content);
      await afterWrite?.(path);
    },
    confinedReplaceFile: async (dir: string, path: string, content: string, mode: number) => {
      await beforeWrite?.(path);
      await actual.confinedReplaceFile(dir, path, content, mode);
      await afterWrite?.(path);
    },
  };
});

beforeEach(() => {
  beforeWrite = undefined;
  afterWrite = undefined;
});

const itUnix = process.platform === 'win32' ? it.skip : it;

function write(dir: string, path: string, content: string): void {
  mkdirSync(dirname(join(dir, path)), { recursive: true });
  writeFileSync(join(dir, path), content);
}

function read(dir: string, path: string): string {
  return readFileSync(join(dir, path), 'utf-8');
}

async function baselines(
  dir: string,
  files: string[],
  anchor?: { file: string; action: 'create' | 'modify' },
): Promise<BundleBaseline[]> {
  const result = await captureBundleBaseline({
    projectDir: dir,
    task: { file: anchor?.file ?? files[0] ?? '', files, action: anchor?.action ?? 'modify' },
  });
  if (result.kind !== 'captured') throw new Error(`capture failed: ${result.error}`);
  return result.baselines;
}

function candidate(
  path: string,
  content: string,
  action: 'create' | 'modify',
): FileBundleCandidate {
  return { path, action, content };
}

async function withDir(name: string, fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = createTempDir(`apply-file-bundle-${name}`);
  try {
    await fn(dir);
  } finally {
    cleanupTempDir(dir);
  }
}

describe('applyFileBundle', () => {
  itUnix(
    'rechecks the model-write guard after approval and preserves control-plane aliases',
    async () => {
      await withDir('guard-after-approval', async (dir) => {
        write(dir, 'src/a.ts', 'initial\n');
        write(dir, '.splitbrief/control.txt', 'private control state\n');
        const captured = await baselines(dir, ['src/a.ts']);
        const result = await applyFileBundle({
          projectDir: dir,
          callId: 'guarded-call',
          baselines: captured,
          candidates: [candidate('src/a.ts', 'model response\n', 'modify')],
          noops: [],
          approveWrite: async () => {
            unlinkSync(join(dir, 'src/a.ts'));
            linkSync(join(dir, '.splitbrief/control.txt'), join(dir, 'src/a.ts'));
            return { allow: true };
          },
        });
        expect(result).toMatchObject({
          status: 'rejected',
          code: 'baseline-conflict',
          applied: [],
        });
        expect(read(dir, '.splitbrief/control.txt')).toBe('private control state\n');
      });
    },
  );

  itUnix('distinguishes an uncertain first write from a proven unchanged failure', async () => {
    await withDir('uncertain-first-write', async (dir) => {
      write(dir, 'src/a.ts', 'initial\n');
      const captured = await baselines(dir, ['src/a.ts']);
      afterWrite = (path) => {
        write(dir, path, 'concurrent content\n');
        throw new Error('write acknowledgement lost');
      };
      const result = await applyFileBundle({
        projectDir: dir,
        callId: 'uncertain-call',
        baselines: captured,
        candidates: [candidate('src/a.ts', 'model response\n', 'modify')],
        noops: [],
      });
      expect(result).toMatchObject({ status: 'failed', code: 'write-uncertain', applied: [] });
      expect(read(dir, 'src/a.ts')).toBe('concurrent content\n');
    });
  });

  itUnix('writes every candidate byte for byte, keeps mode and counts no-ops apart', async () => {
    await withDir('applied', async (dir) => {
      write(dir, 'src/a.ts', 'const a = 1;\r\nconst b = 2;\r\n');
      write(dir, 'src/same.ts', 'untouched by the response\n');
      const captured = await baselines(dir, [
        'src/a.ts',
        'src/new.ts',
        'src/same.ts',
        'src/gone.ts',
      ]);

      const result = await applyFileBundle({
        projectDir: dir,
        callId: 'implementer-1',
        baselines: captured,
        candidates: [
          candidate('src/new.ts', '', 'create'),
          candidate('src/a.ts', 'const a = 1;\r\nconst c = 3;', 'modify'),
        ],
        noops: ['src/same.ts'],
      });

      expect(result.status).toBe('applied');
      expect(result.applied.map((file) => file.path)).toEqual(['src/a.ts', 'src/new.ts']);
      expect(result.noops).toEqual(['src/same.ts']);
      expect(result.untouched).toEqual(['src/gone.ts']);
      expect(read(dir, 'src/a.ts')).toBe('const a = 1;\r\nconst c = 3;');
      expect(read(dir, 'src/new.ts')).toBe('');
      expect(read(dir, 'src/same.ts')).toBe('untouched by the response\n');

      const modified = result.applied[0];
      expect(modified).toMatchObject({ action: 'modify', linesAdded: 1, linesRemoved: 2 });
      expect(modified?.beforeSha256).toMatch(/^[0-9a-f]{64}$/);
      expect(modified?.afterSha256).not.toBe(modified?.beforeSha256);
      expect(result.applied[1]).toMatchObject({ action: 'create', beforeSha256: null });
    });
  });

  itUnix('retains the mode of a modified file', async () => {
    await withDir('mode', async (dir) => {
      write(dir, 'bin/run.sh', '#!/bin/sh\necho old\n');
      chmodSync(join(dir, 'bin/run.sh'), 0o755);
      const captured = await baselines(dir, ['bin/run.sh']);

      const result = await applyFileBundle({
        projectDir: dir,
        callId: 'implementer-1',
        baselines: captured,
        candidates: [candidate('bin/run.sh', '#!/bin/sh\necho new\n', 'modify')],
        noops: [],
      });

      expect(result.status).toBe('applied');
      expect(statSync(join(dir, 'bin/run.sh')).mode & 0o777).toBe(0o755);
    });
  });

  itUnix('writes nothing when a later file is denied', async () => {
    await withDir('denied', async (dir) => {
      write(dir, 'src/a.ts', 'a\n');
      write(dir, 'src/b.ts', 'b\n');
      const captured = await baselines(dir, ['src/a.ts', 'src/b.ts']);

      const result = await applyFileBundle({
        projectDir: dir,
        callId: 'implementer-1',
        baselines: captured,
        candidates: [
          candidate('src/a.ts', 'a changed\n', 'modify'),
          candidate('src/b.ts', 'b changed\n', 'modify'),
        ],
        noops: [],
        approveWrite: (path) =>
          Promise.resolve(
            path === 'src/b.ts'
              ? { allow: false, reason: 'operator declined src/b.ts' }
              : { allow: true },
          ),
      });

      expect(result).toMatchObject({
        status: 'rejected',
        code: 'denied',
        error: 'operator declined src/b.ts',
        applied: [],
        untouched: ['src/a.ts', 'src/b.ts'],
      });
      expect(read(dir, 'src/a.ts')).toBe('a\n');
      expect(read(dir, 'src/b.ts')).toBe('b\n');
    });
  });

  itUnix('records only the first file when the second write fails', async () => {
    await withDir('partial-io', async (dir) => {
      write(dir, 'src/a.ts', 'a\n');
      write(dir, 'src/b.ts', 'b\n');
      write(dir, 'src/c.ts', 'c\n');
      const captured = await baselines(dir, ['src/a.ts', 'src/b.ts', 'src/c.ts']);
      beforeWrite = (path) => {
        if (path === 'src/b.ts') throw new Error('EIO: simulated device failure');
      };

      const result = await applyFileBundle({
        projectDir: dir,
        callId: 'implementer-1',
        baselines: captured,
        candidates: [
          candidate('src/a.ts', 'a changed\n', 'modify'),
          candidate('src/b.ts', 'b changed\n', 'modify'),
          candidate('src/c.ts', 'c changed\n', 'modify'),
        ],
        noops: [],
      });

      expect(result).toMatchObject({
        status: 'partial',
        code: 'io-failure',
        failedPath: 'src/b.ts',
        untouched: ['src/b.ts', 'src/c.ts'],
      });
      expect(result.status === 'partial' && result.error).toMatch(/simulated device failure/);
      expect(result.applied.map((file) => file.path)).toEqual(['src/a.ts']);
      expect(read(dir, 'src/a.ts')).toBe('a changed\n');
      expect(read(dir, 'src/b.ts')).toBe('b\n');
      expect(read(dir, 'src/c.ts')).toBe('c\n');
    });
  });

  itUnix('fails rather than partially applies when the first write fails', async () => {
    await withDir('failed-io', async (dir) => {
      write(dir, 'src/a.ts', 'a\n');
      const captured = await baselines(dir, ['src/a.ts']);
      beforeWrite = () => {
        throw new Error('EIO: simulated device failure');
      };

      const result = await applyFileBundle({
        projectDir: dir,
        callId: 'implementer-1',
        baselines: captured,
        candidates: [candidate('src/a.ts', 'a changed\n', 'modify')],
        noops: [],
      });

      expect(result).toMatchObject({
        status: 'failed',
        code: 'io-failure',
        failedPath: 'src/a.ts',
        applied: [],
        untouched: ['src/a.ts'],
      });
      expect(read(dir, 'src/a.ts')).toBe('a\n');
    });
  });

  itUnix('never clobbers a file that appears between the recheck and the create', async () => {
    await withDir('no-clobber', async (dir) => {
      const captured = await baselines(dir, ['src/new.ts'], {
        file: 'src/new.ts',
        action: 'create',
      });
      expect(captured[0]).toMatchObject({ operation: 'create', kind: 'missing' });
      beforeWrite = (path) => {
        if (path === 'src/new.ts') write(dir, path, 'written by someone else\n');
      };

      const result = await applyFileBundle({
        projectDir: dir,
        callId: 'implementer-1',
        baselines: captured,
        candidates: [candidate('src/new.ts', 'from the response\n', 'create')],
        noops: [],
      });

      expect(result).toMatchObject({
        status: 'failed',
        code: 'write-uncertain',
        failedPath: 'src/new.ts',
      });
      expect(read(dir, 'src/new.ts')).toBe('written by someone else\n');
    });
  });

  itUnix('refuses everything when a target moved before the first write', async () => {
    await withDir('conflict', async (dir) => {
      write(dir, 'src/a.ts', 'a\n');
      write(dir, 'src/b.ts', 'b\n');
      const captured = await baselines(dir, ['src/a.ts', 'src/b.ts']);
      write(dir, 'src/b.ts', 'edited by the user\n');

      const result = await applyFileBundle({
        projectDir: dir,
        callId: 'implementer-1',
        baselines: captured,
        candidates: [
          candidate('src/a.ts', 'a changed\n', 'modify'),
          candidate('src/b.ts', 'b changed\n', 'modify'),
        ],
        noops: [],
      });

      expect(result).toMatchObject({
        status: 'rejected',
        code: 'baseline-conflict',
        applied: [],
        untouched: ['src/a.ts', 'src/b.ts'],
      });
      expect(result.status === 'rejected' && result.error).toMatch(
        /src\/b\.ts: target content changed/,
      );
      expect(read(dir, 'src/a.ts')).toBe('a\n');
    });
  });

  itUnix('keeps the first file when cancellation arrives between writes', async () => {
    await withDir('cancel-between', async (dir) => {
      write(dir, 'src/a.ts', 'a\n');
      write(dir, 'src/b.ts', 'b\n');
      const captured = await baselines(dir, ['src/a.ts', 'src/b.ts']);
      const controller = new AbortController();
      afterWrite = (path) => {
        if (path === 'src/a.ts') controller.abort();
      };

      const result = await applyFileBundle({
        projectDir: dir,
        callId: 'implementer-1',
        baselines: captured,
        candidates: [
          candidate('src/a.ts', 'a changed\n', 'modify'),
          candidate('src/b.ts', 'b changed\n', 'modify'),
        ],
        noops: [],
        signal: controller.signal,
      });

      expect(result).toMatchObject({
        status: 'partial',
        code: 'cancelled',
        failedPath: 'src/b.ts',
        untouched: ['src/b.ts'],
      });
      expect(result.applied.map((file) => file.path)).toEqual(['src/a.ts']);
      expect(read(dir, 'src/a.ts')).toBe('a changed\n');
      expect(read(dir, 'src/b.ts')).toBe('b\n');
    });
  });

  itUnix('rejects when cancellation arrives before the first write', async () => {
    await withDir('cancel-before', async (dir) => {
      write(dir, 'src/a.ts', 'a\n');
      const captured = await baselines(dir, ['src/a.ts']);
      const controller = new AbortController();
      controller.abort();

      const result = await applyFileBundle({
        projectDir: dir,
        callId: 'implementer-1',
        baselines: captured,
        candidates: [candidate('src/a.ts', 'a changed\n', 'modify')],
        noops: [],
        signal: controller.signal,
      });

      expect(result).toMatchObject({ status: 'rejected', code: 'cancelled', applied: [] });
      expect(read(dir, 'src/a.ts')).toBe('a\n');
    });
  });

  itUnix('refuses the whole bundle when one modify keeps under half its lines', async () => {
    await withDir('shrink', async (dir) => {
      write(dir, 'src/big.ts', ['one', 'two', '', 'three', 'four', 'five'].join('\n'));
      write(dir, 'src/a.ts', 'a\n');
      const captured = await baselines(dir, ['src/a.ts', 'src/big.ts']);

      const result = await applyFileBundle({
        projectDir: dir,
        callId: 'implementer-1',
        baselines: captured,
        candidates: [
          candidate('src/a.ts', 'a changed\n', 'modify'),
          candidate('src/big.ts', 'one\ntwo\n', 'modify'),
        ],
        noops: [],
        approveWrite: () => Promise.reject(new Error('approval must not be asked')),
      });

      expect(result).toMatchObject({
        status: 'rejected',
        code: 'implausible-rewrite',
        applied: [],
        untouched: ['src/a.ts', 'src/big.ts'],
      });
      expect(result.status === 'rejected' && result.error).toMatch(/keeps 2 of 5 non-empty lines/);
      expect(read(dir, 'src/a.ts')).toBe('a\n');
      expect(read(dir, 'src/big.ts')).toBe('one\ntwo\n\nthree\nfour\nfive');
    });
  });
});
