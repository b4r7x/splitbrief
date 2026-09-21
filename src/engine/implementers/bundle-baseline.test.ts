import { describe, it, expect } from 'vitest';
import { chmodSync, linkSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createTempDir, cleanupTempDir } from '#testing/helpers/temp-dir.js';
import { captureBundleBaseline, compareBundleBaseline } from './bundle-baseline.js';
import type { CaptureBundleBaselineInput } from './bundle-baseline.js';

const itUnix = process.platform === 'win32' ? it.skip : it;

function write(dir: string, path: string, content: Buffer | string): void {
  mkdirSync(dirname(join(dir, path)), { recursive: true });
  writeFileSync(join(dir, path), content);
}

function capture(
  dir: string,
  task: CaptureBundleBaselineInput['task'],
  createdByThisTask?: readonly string[],
) {
  return captureBundleBaseline({
    projectDir: dir,
    task,
    ...(createdByThisTask && { createdByThisTask }),
  });
}

async function withDir(name: string, fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = createTempDir(`bundle-baseline-${name}`);
  try {
    await fn(dir);
  } finally {
    cleanupTempDir(dir);
  }
}

describe('captureBundleBaseline', () => {
  itUnix(
    'rejects control-plane targets and their aliases before reading their contents',
    async () => {
      await withDir('control-plane', async (dir) => {
        write(dir, '.splitbrief/control.txt', 'private control state');
        symlinkSync(join(dir, '.splitbrief'), join(dir, 'alias'));
        linkSync(join(dir, '.splitbrief/control.txt'), join(dir, 'linked.txt'));
        for (const path of [
          '.git/new.txt',
          '.splitbrief/control.txt',
          'alias/control.txt',
          'linked.txt',
        ]) {
          expect(await capture(dir, { file: path, action: 'modify' })).toMatchObject({
            kind: 'rejected',
            code: 'unsafe-target',
            path,
          });
        }
      });
    },
  );

  itUnix('tells missing apart from a symlink, a directory, invalid UTF-8 and binary', async () => {
    await withDir('unsupported', async (dir) => {
      write(dir, 'src/real.ts', 'export const a = 1;\n');
      symlinkSync(join(dir, 'src/real.ts'), join(dir, 'src/link.ts'));
      mkdirSync(join(dir, 'src/folder'), { recursive: true });
      write(dir, 'src/latin1.ts', Buffer.from([0x61, 0xff, 0xfe, 0x0a]));
      write(dir, 'src/blob.ts', Buffer.from([0x61, 0x00, 0x62]));

      const absent = await capture(dir, { file: 'src/new.ts', action: 'create' });
      expect(absent).toEqual({
        kind: 'captured',
        baselines: [{ path: 'src/new.ts', operation: 'create', kind: 'missing' }],
      });

      for (const [path, reason] of [
        ['src/link.ts', /symlink/i],
        ['src/folder', /regular file/i],
        ['src/latin1.ts', /not valid UTF-8/],
        ['src/blob.ts', /binary/],
      ] as const) {
        const result = await capture(dir, { file: path, action: 'modify' });
        expect(result).toMatchObject({ kind: 'rejected', code: 'unsafe-target', path });
        expect(result.kind === 'rejected' && result.error).toMatch(reason);
      }
    });
  });

  itUnix('captures content, digest and mode, and derives non-anchor operations', async () => {
    await withDir('capture', async (dir) => {
      write(dir, 'src/app.ts', '﻿export const a = 1;\r\n');
      chmodSync(join(dir, 'src/app.ts'), 0o755);

      const result = await capture(dir, {
        file: 'src/app.ts',
        files: ['src/app.ts', 'src/new.ts'],
        action: 'modify',
      });
      expect(result).toEqual({
        kind: 'captured',
        baselines: [
          {
            path: 'src/app.ts',
            operation: 'modify',
            kind: 'text',
            content: '﻿export const a = 1;\r\n',
            sha256: expect.stringMatching(/^[0-9a-f]{64}$/),
            mode: 0o755,
          },
          { path: 'src/new.ts', operation: 'create', kind: 'missing' },
        ],
      });
    });
  });

  itUnix('refuses an anchor whose action contradicts the disk', async () => {
    await withDir('anchor', async (dir) => {
      write(dir, 'src/app.ts', 'export const a = 1;\n');

      expect(await capture(dir, { file: 'src/app.ts', action: 'create' })).toMatchObject({
        kind: 'rejected',
        code: 'baseline-conflict',
        path: 'src/app.ts',
        error: 'the brief says create but the anchor already exists',
      });
      expect(await capture(dir, { file: 'src/gone.ts', action: 'modify' })).toMatchObject({
        kind: 'rejected',
        code: 'baseline-conflict',
        error: 'the brief says modify but the anchor is missing',
      });

      const retry = await capture(dir, { file: 'src/app.ts', action: 'create' }, ['src/app.ts']);
      expect(retry).toMatchObject({
        kind: 'captured',
        baselines: [{ path: 'src/app.ts', operation: 'modify', content: 'export const a = 1;\n' }],
      });
      const unrelated = await capture(dir, { file: 'src/app.ts', action: 'create' }, [
        'src/other.ts',
      ]);
      expect(unrelated).toMatchObject({ kind: 'rejected', code: 'baseline-conflict' });
    });
  });

  itUnix('rejects unsafe spellings, aliases and ancestor collisions', async () => {
    await withDir('paths', async (dir) => {
      write(dir, 'src/app.ts', 'a\n');
      write(dir, 'src/dup.ts', 'duplicate\n');
      linkSync(join(dir, 'src/app.ts'), join(dir, 'src/alias.ts'));

      const cases: Array<[string[], RegExp]> = [
        [['src/app.ts', 'src/../src/app.ts'], /`\.` or `\.\.` segment/],
        [['src/dup.ts', 'src/dup.ts'], /duplicate declared target/],
        [['src/tree', 'src/tree/inner.ts'], /collides with declared target/],
        [['src/alias.ts', 'src/app.ts'], /hardlink/],
        [['src/app.ts', '/etc/passwd'], /absolute path/],
      ];
      for (const [files, reason] of cases) {
        const result = await capture(dir, { file: 'src/app.ts', files, action: 'modify' });
        expect(result).toMatchObject({ kind: 'rejected', code: 'unsafe-target' });
        expect(result.kind === 'rejected' && result.error).toMatch(reason);
      }

      const many = Array.from({ length: 33 }, (_, i) => `src/f${i}.ts`);
      expect(
        await capture(dir, { file: many[0] ?? '', files: many, action: 'create' }),
      ).toMatchObject({ kind: 'rejected', code: 'output-limit' });
    });
  });
});

describe('compareBundleBaseline', () => {
  itUnix('detects the same bytes under a different file mode', async () => {
    await withDir('mode', async (dir) => {
      write(dir, 'src/run.sh', 'echo hi\n');
      const captured = await capture(dir, { file: 'src/run.sh', action: 'modify' });
      if (captured.kind !== 'captured') throw new Error('capture failed');
      expect(await compareBundleBaseline(dir, captured.baselines)).toEqual({ kind: 'match' });

      chmodSync(join(dir, 'src/run.sh'), 0o755);
      expect(await compareBundleBaseline(dir, captured.baselines)).toEqual({
        kind: 'conflict',
        path: 'src/run.sh',
        error: 'target file mode changed',
      });
    });
  });

  itUnix(
    'refuses every write when the user edits the second file while approval waits',
    async () => {
      await withDir('concurrent', async (dir) => {
        write(dir, 'src/first.ts', 'first\n');
        write(dir, 'src/second.ts', 'second\n');
        const captured = await capture(dir, {
          file: 'src/first.ts',
          files: ['src/first.ts', 'src/second.ts'],
          action: 'modify',
        });
        if (captured.kind !== 'captured') throw new Error('capture failed');

        write(dir, 'src/second.ts', 'user edit\n');

        expect(await compareBundleBaseline(dir, captured.baselines)).toEqual({
          kind: 'conflict',
          path: 'src/second.ts',
          error: 'target content changed',
        });
        // The pre-write recheck of the untouched first file still matches, so only
        // the whole-set comparison stops its write.
        expect(await compareBundleBaseline(dir, captured.baselines.slice(0, 1))).toEqual({
          kind: 'match',
        });
      });
    },
  );

  itUnix('conflicts when a create target appeared or a modify target vanished', async () => {
    await withDir('presence', async (dir) => {
      write(dir, 'src/app.ts', 'a\n');
      const captured = await capture(dir, {
        file: 'src/app.ts',
        files: ['src/app.ts', 'src/new.ts'],
        action: 'modify',
      });
      if (captured.kind !== 'captured') throw new Error('capture failed');

      write(dir, 'src/new.ts', 'the user got there first\n');
      expect(await compareBundleBaseline(dir, captured.baselines)).toEqual({
        kind: 'conflict',
        path: 'src/new.ts',
        error: 'target now exists',
      });

      rmSync(join(dir, 'src/new.ts'));
      rmSync(join(dir, 'src/app.ts'));
      expect(await compareBundleBaseline(dir, captured.baselines)).toEqual({
        kind: 'conflict',
        path: 'src/app.ts',
        error: 'target no longer exists',
      });

      symlinkSync('/etc/passwd', join(dir, 'src/swapped.ts'));
      const swapped = await compareBundleBaseline(dir, [
        { path: 'src/swapped.ts', operation: 'create', kind: 'missing' },
      ]);
      expect(swapped).toMatchObject({ kind: 'conflict', path: 'src/swapped.ts' });
    });
  });
});
