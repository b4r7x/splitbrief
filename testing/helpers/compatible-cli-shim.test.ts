import { readdirSync } from 'node:fs';
import { delimiter } from 'node:path';
import { expect, it } from 'vitest';
import { resolveCustomExecutable } from '../../src/engine/runners/resolve-cli-executable.js';
import { safeChildEnvironment } from '../integration/cli/pty/run.js';
import { activateSafeCliShimPath } from './compatible-cli-shim.js';
import { cleanupTempDir, createTempDir } from './temp-dir.js';

it('puts only node, npm and npx beside the shim directory', () => {
  const shimDir = createTempDir('compatible-cli-shim-path');
  const originalPath = process.env.PATH;
  const restore = activateSafeCliShimPath(shimDir);
  const entries = process.env.PATH?.split(delimiter) ?? [];
  const runtime = entries[1] ?? '';
  try {
    expect(entries).toEqual([shimDir, runtime, '/usr/bin', '/bin']);
    expect(readdirSync(runtime).sort()).toEqual(['node', 'npm', 'npx']);
  } finally {
    restore();
    cleanupTempDir(shimDir);
  }
  expect(process.env.PATH).toBe(originalPath);
});

it("resolves node to one path under this process's PATH and the PTY child's PATH", async () => {
  const root = createTempDir('compatible-cli-shim-node');
  const shimDir = createTempDir('compatible-cli-shim-path');
  const restore = activateSafeCliShimPath(shimDir);
  try {
    const resolveNode = async (pathEnv: string) =>
      resolveCustomExecutable({ command: 'node', projectDir: root, pathEnv, pathExt: '' });
    const parent = await resolveNode(process.env.PATH ?? '');
    if (parent.kind !== 'resolved') throw new Error('Node executable did not resolve');
    const { executable } = parent;
    expect(await resolveNode(safeChildEnvironment(root, [shimDir]).PATH ?? '')).toEqual({
      kind: 'resolved',
      executable: {
        ...executable,
        executableIdentity: { ...executable.executableIdentity, resolvedAt: expect.any(Number) },
      },
    });
  } finally {
    restore();
    cleanupTempDir(shimDir);
    cleanupTempDir(root);
  }
});
