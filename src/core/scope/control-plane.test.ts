import { afterEach, describe, it, expect } from 'vitest';
import { linkSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createTempDir, cleanupTempDir } from '#testing/helpers/temp-dir.js';
import { assertModelWritablePathConfined } from './control-plane.js';

const itUnix = process.platform === 'win32' ? it.skip : it;
const tmpDirs: string[] = [];

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) cleanupTempDir(dir);
});

describe('assertModelWritablePathConfined — control plane', () => {
  it.each([
    ['.git/config', '.git/config'],
    ['nested .git path', '.git/hooks/pre-commit'],
    ['.splitbrief/config.yaml', '.splitbrief/config.yaml'],
    ['nested .splitbrief path', '.splitbrief/sessions/s/state.json'],
  ])('rejects model-named write to %s', (_label, path) => {
    const root = createTempDir('path-conf-cp-root');
    tmpDirs.push(root);
    expect(() => assertModelWritablePathConfined(path, root)).toThrow(/control plane/);
  });

  it('still allows ordinary in-repo source paths', () => {
    const root = createTempDir('path-conf-cp-ok');
    tmpDirs.push(root);
    expect(() => assertModelWritablePathConfined('src/feature/foo.ts', root)).not.toThrow();
  });

  itUnix('rejects a model-named write reaching .git through an in-repo symlink', () => {
    const root = createTempDir('path-conf-cp-symlink');
    tmpDirs.push(root);
    mkdirSync(join(root, '.git'), { recursive: true });
    symlinkSync(join(root, '.git'), join(root, 'evil'));

    expect(() => assertModelWritablePathConfined('evil/config', root)).toThrow(/control plane/);
  });

  itUnix('rejects a model-named write to a hardlink targeting a control-plane file', () => {
    const root = createTempDir('path-conf-cp-hardlink');
    tmpDirs.push(root);
    mkdirSync(join(root, '.git'), { recursive: true });
    writeFileSync(join(root, '.git', 'config'), '[core]\n');
    linkSync(join(root, '.git', 'config'), join(root, 'innocent.txt'));

    expect(() => assertModelWritablePathConfined('innocent.txt', root)).toThrow(/hardlink/);
  });
});
