import { chmodSync, realpathSync, unlinkSync, writeFileSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { afterEach, describe, expect } from 'vitest';
import { resolveCustomExecutable } from './custom.js';
import { itUnix, makeExecutable } from '#testing/helpers/cli-executable.js';
import { cleanupTempDir, createTempDir } from '#testing/helpers/temp-dir.js';

let dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs) cleanupTempDir(dir);
  dirs = [];
});

describe('resolveCustomExecutable', () => {
  itUnix('resolves exact identity from the candidate path and bytes', async () => {
    const projectDir = createTempDir('custom-resolver-no-spawn-project');
    const binDir = createTempDir('custom-resolver-no-spawn-bin');
    dirs.push(projectDir, binDir);
    const executable = join(binDir, 'custom-runner');
    makeExecutable(executable);

    const result = await resolveCustomExecutable({
      command: executable,
      projectDir,
      pathEnv: binDir,
    });

    expect(result).toMatchObject({
      kind: 'resolved',
      executable: {
        path: realpathSync(executable),
        executableIdentity: { fingerprint: expect.stringContaining(':sha256:') },
      },
    });
  });

  itUnix('distinguishes missing, non-executable, and invalid candidates', async () => {
    const projectDir = createTempDir('custom-resolver-outcomes-project');
    const binDir = createTempDir('custom-resolver-outcomes-bin');
    dirs.push(projectDir, binDir);
    const nonExecutable = join(binDir, 'not-executable');
    writeFileSync(nonExecutable, '#!/bin/sh\nexit 0\n', { mode: 0o600 });
    chmodSync(nonExecutable, 0o600);

    await expect(
      resolveCustomExecutable({ command: 'missing', projectDir, pathEnv: binDir }),
    ).resolves.toEqual({ kind: 'missing' });
    await expect(
      resolveCustomExecutable({ command: nonExecutable, projectDir, pathEnv: binDir }),
    ).resolves.toEqual({ kind: 'non-executable' });
    await expect(
      resolveCustomExecutable({ command: ' invalid ', projectDir, pathEnv: binDir }),
    ).resolves.toEqual({ kind: 'invalid' });
  });

  itUnix('does not skip a non-executable PATH shadow for a later candidate', async () => {
    const projectDir = createTempDir('custom-resolver-shadow-project');
    const firstDir = createTempDir('custom-resolver-shadow-first');
    const secondDir = createTempDir('custom-resolver-shadow-second');
    dirs.push(projectDir, firstDir, secondDir);
    writeFileSync(join(firstDir, 'custom-runner'), '#!/bin/sh\nexit 0\n', { mode: 0o600 });
    makeExecutable(join(secondDir, 'custom-runner'));

    await expect(
      resolveCustomExecutable({
        command: 'custom-runner',
        projectDir,
        pathEnv: [firstDir, secondDir].join(delimiter),
      }),
    ).resolves.toEqual({ kind: 'non-executable' });
  });

  itUnix('fails closed on exact executable identity drift', async () => {
    const projectDir = createTempDir('custom-resolver-drift-project');
    const binDir = createTempDir('custom-resolver-drift-bin');
    dirs.push(projectDir, binDir);
    const executable = join(binDir, 'custom-runner');
    makeExecutable(executable, '#!/bin/sh\necho original\n');
    const first = await resolveCustomExecutable({ command: executable, projectDir });
    expect(first.kind).toBe('resolved');
    if (first.kind !== 'resolved') throw new Error('fixture executable did not resolve');

    makeExecutable(executable, '#!/bin/sh\necho replacement\n');

    await expect(
      resolveCustomExecutable({
        command: executable,
        projectDir,
        expected: first.executable,
      }),
    ).resolves.toMatchObject({
      kind: 'identity-drifted',
      executable: { path: realpathSync(executable) },
    });
  });

  itUnix('reports a removed executable as missing, not changed', async () => {
    const projectDir = createTempDir('custom-resolver-removed-project');
    const binDir = createTempDir('custom-resolver-removed-bin');
    dirs.push(projectDir, binDir);
    const executable = join(binDir, 'custom-runner');
    makeExecutable(executable);
    const first = await resolveCustomExecutable({ command: executable, projectDir });
    if (first.kind !== 'resolved') throw new Error('fixture executable did not resolve');

    unlinkSync(executable);

    await expect(
      resolveCustomExecutable({ command: executable, projectDir, expected: first.executable }),
    ).resolves.toEqual({ kind: 'missing' });
    await expect(
      resolveCustomExecutable({
        command: 'custom-runner',
        projectDir,
        pathEnv: binDir,
        expected: first.executable,
      }),
    ).resolves.toEqual({ kind: 'missing' });
  });
});
