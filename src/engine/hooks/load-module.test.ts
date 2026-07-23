import { describe, it, expect } from 'vitest';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { loadHookModule } from './load-module.js';

const projectDir = resolve('.');

describe('loadHookModule', () => {
  it('loads a valid module and returns the default function', async () => {
    const result = await loadHookModule('testing/fixtures/hooks/sample-module.mjs', projectDir);
    expect(result.ok).toBe(true);
  });

  it('returns ok:false on missing file', async () => {
    const result = await loadHookModule('./does-not-exist.mjs', projectDir);
    expect(result.ok).toBe(false);
  });

  it('returns ok:false when module has no default export', async () => {
    const modulePath = 'testing/fixtures/hooks/no-default-export.mjs';
    const resolvedPath = resolve(projectDir, modulePath);
    const result = await loadHookModule(modulePath, projectDir);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain(resolvedPath);
      expect(result.reason).toContain('default function');
      expect(result.reason).toContain('undefined');
    }
  });

  it('returns ok:false when default export is not a function', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'diptych-hook-module-'));
    const modulePath = 'default-string.mjs';
    try {
      await writeFile(join(tempDir, modulePath), 'export default "not a function";');
      const result = await loadHookModule(modulePath, tempDir);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toContain(join(tempDir, modulePath));
        expect(result.reason).toContain('default function');
        expect(result.reason).toContain('string');
      }
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it('rejects absolute module paths', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'diptych-hook-module-'));
    const modulePath = join(tempDir, 'hook.mjs');
    try {
      await writeFile(modulePath, 'export default () => ({ kind: "allow" });');
      const result = await loadHookModule(modulePath, projectDir);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toContain('absolute paths not allowed');
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it('rejects module paths that escape the project root', async () => {
    const result = await loadHookModule('../hook.mjs', projectDir);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain('path escapes root directory');
  });

  it('rejects symlinks that resolve outside the project root', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'diptych-hook-module-'));
    const outsideDir = await mkdtemp(join(tmpdir(), 'diptych-hook-outside-'));
    try {
      await mkdir(join(tempDir, 'hooks'));
      await writeFile(join(outsideDir, 'hook.mjs'), 'export default () => ({ kind: "allow" });');
      await symlink(join(outsideDir, 'hook.mjs'), join(tempDir, 'hooks', 'hook.mjs'));

      const result = await loadHookModule('hooks/hook.mjs', tempDir);

      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toContain('path escapes root directory');
    } finally {
      await rm(tempDir, { recursive: true, force: true });
      await rm(outsideDir, { recursive: true, force: true });
    }
  });
});
