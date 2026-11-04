import { statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { withTempDir } from '#testing/helpers/temp-dir.js';
import { loadNodePtyCapability, type PtyExitEvent } from './pty/capability.js';
import { runWithPtyChild, safeChildEnvironment } from './pty/run.js';

const require = createRequire(import.meta.url);

function nodePtySpawnHelperPath(): string {
  const utilsPath = require.resolve('node-pty/lib/utils.js');
  const utils = require(utilsPath) as {
    loadNativeModule: (name: string) => { readonly dir: string };
  };
  return resolve(dirname(utilsPath), utils.loadNativeModule('pty').dir, 'spawn-helper');
}

describe.runIf(process.platform === 'darwin')('node-pty spawn helper on macOS', () => {
  it('leaves the spawn helper that node-pty uses executable by its owner once loaded', async () => {
    const capability = await loadNodePtyCapability();

    expect(capability.kind).toBe('available');
    expect(statSync(nodePtySpawnHelperPath()).mode & 0o100).toBe(0o100);
  });

  it('spawns a child through the loaded capability and sees it exit 0', async () => {
    await withTempDir('pty-spawn-helper', async (dir) => {
      const exit = await runWithPtyChild(
        {
          requirement: 'required',
          argv: ['-e', ''],
          spawnOptions: {
            name: 'xterm-256color',
            cols: 80,
            rows: 24,
            cwd: dir,
            env: safeChildEnvironment(dir),
          },
        },
        async (child) => {
          const exited = Promise.withResolvers<PtyExitEvent>();
          const exitListener = child.onExit(exited.resolve);
          try {
            return await exited.promise;
          } finally {
            exitListener.dispose();
          }
        },
      );

      expect(exit).toMatchObject({ exitCode: 0 });
    });
  });
});
