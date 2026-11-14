import { describe, expect } from 'vitest';
import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { linkStaysInProject, readProjectSymlink } from './link.js';
import { createTempDir, cleanupTempDir } from '#testing/helpers/temp-dir.js';
import { itUnix } from '#testing/helpers/file-snapshot-entry.js';

describe('confined file snapshot entries', () => {
  itUnix('reads a symlink target only when the link stays inside the project', async () => {
    const dir = createTempDir('entry-project-link');
    const outside = createTempDir('entry-project-link-outside');
    try {
      mkdirSync(join(dir, 'skills', 'babysit'), { recursive: true });
      mkdirSync(join(dir, '.claude', 'skills'), { recursive: true });
      writeFileSync(join(dir, 'plain.txt'), 'plain');
      symlinkSync('../../skills/babysit', join(dir, '.claude', 'skills', 'babysit'), 'dir');
      symlinkSync('missing.txt', join(dir, 'dangling.txt'));
      symlinkSync(join(dir, 'skills'), join(dir, 'absolute'), 'dir');
      symlinkSync(`../${basename(outside)}`, join(dir, 'escaping'), 'dir');
      symlinkSync(outside, join(dir, 'exit'), 'dir');
      symlinkSync('exit/secret.txt', join(dir, 'through-exit.txt'));
      // Back inside only through the root's own name, which a copy of the tree does not share.
      symlinkSync(`../${basename(dir)}/plain.txt`, join(dir, 'climbing.txt'));

      expect(await readProjectSymlink(dir, '.claude/skills/babysit')).toBe('../../skills/babysit');
      expect(await readProjectSymlink(dir, 'dangling.txt')).toBe('missing.txt');
      for (const file of [
        'absolute',
        'escaping',
        'exit',
        'through-exit.txt',
        'climbing.txt',
        'plain.txt',
        'none',
      ]) {
        expect(await readProjectSymlink(dir, file)).toBeNull();
      }
    } finally {
      cleanupTempDir(outside);
      cleanupTempDir(dir);
    }
  });

  // The kernel resolves a name before the `..` after it, so `sub/..` climbs from
  // wherever `sub` points, never from where the spelling says.
  itUnix(
    'reads a link target by where the kernel lands it: inside the root, outside the control plane',
    async () => {
      const root = createTempDir('entry-link-landing');
      const dir = join(root, 'project');
      try {
        mkdirSync(join(dir, 'a', 'b'), { recursive: true });
        mkdirSync(join(dir, '.git'));
        mkdirSync(join(root, 'outside'));
        writeFileSync(join(root, 'outside', 'secret'), 'secret');
        writeFileSync(join(dir, 'real.txt'), 'real');
        symlinkSync('.', join(dir, 'sub'));
        symlinkSync('..', join(dir, 'a', 'up'));
        symlinkSync('sub/../outside/secret', join(dir, 'evil'));
        symlinkSync('a/up/../outside/secret', join(dir, 'evil-up'));
        symlinkSync('sub/../outside/missing', join(dir, 'evil-dangling'));
        symlinkSync('../../outside/secret', join(dir, 'a', 'hop'));
        symlinkSync('a/hop', join(dir, 'chain'));
        symlinkSync('.git', join(dir, 'gitlink'));
        symlinkSync('../.git', join(dir, 'a', 'gitlink'));
        symlinkSync('.git/missing', join(dir, 'gitlink-dangling'));
        symlinkSync('loop-b', join(dir, 'loop-a'));
        symlinkSync('loop-a', join(dir, 'loop-b'));
        symlinkSync('..', join(dir, 'a', 'b', 'up'));
        symlinkSync('.', join(dir, 'a', 'self'));
        symlinkSync('real.txt', join(dir, 'plain-link'));
        symlinkSync(join(root, 'outside', 'missing'), join(dir, 'gone'));
        symlinkSync('gone/secret', join(dir, 'through-dangling'));
        symlinkSync('missing/../climb', join(dir, 'climb'));
        symlinkSync('climb/x', join(dir, 'through-climb'));

        expect(await readProjectSymlink(dir, 'sub')).toBe('.');
        expect(await readProjectSymlink(dir, 'a/up')).toBe('..');
        expect(await readProjectSymlink(dir, 'a/b/up')).toBe('..');
        expect(await readProjectSymlink(dir, 'a/self')).toBe('.');
        expect(await readProjectSymlink(dir, 'plain-link')).toBe('real.txt');
        for (const file of [
          'evil',
          'evil-up',
          'evil-dangling',
          'chain',
          'gitlink',
          'a/gitlink',
          'gitlink-dangling',
          'loop-a',
          'through-dangling',
          'through-climb',
        ]) {
          expect(await readProjectSymlink(dir, file), file).toBeNull();
        }
      } finally {
        cleanupTempDir(root);
      }
    },
  );

  itUnix('lands a link not yet written through the links of the tree it would join', async () => {
    const root = createTempDir('entry-link-would-land');
    const dir = join(root, 'project');
    try {
      mkdirSync(join(root, 'outside'), { recursive: true });
      mkdirSync(dir);
      writeFileSync(join(dir, 'real.txt'), 'real');
      symlinkSync(join(root, 'outside'), join(dir, 'sub'));
      symlinkSync(join(root, 'outside', 'missing'), join(dir, 'gone'));
      symlinkSync('sub/../missing', join(dir, 'climb'));

      expect(await linkStaysInProject(dir, 'docs/x', '../real.txt')).toBe(true);
      expect(await linkStaysInProject(dir, 'docs/x', '../new/y')).toBe(true);
      expect(await linkStaysInProject(dir, 'docs/x', '../sub/y')).toBe(false);
      expect(await linkStaysInProject(dir, 'docs/x', '../gone/y')).toBe(false);
      expect(await linkStaysInProject(dir, 'docs/x', '../climb/y')).toBe(false);
      expect(await linkStaysInProject(dir, 'docs/x', '../../outside/y')).toBe(false);
    } finally {
      cleanupTempDir(root);
    }
  });
});
