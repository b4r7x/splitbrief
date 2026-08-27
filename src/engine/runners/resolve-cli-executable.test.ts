import {
  chmodSync,
  mkdirSync,
  realpathSync,
  statSync,
  symlinkSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { delimiter, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { CliExecutableIdentity } from '../../core/discovery/detection.js';
import type { ExecutableIdentity } from '../../core/discovery/runner-evidence.js';
import { CURSOR_CLI_CANDIDATE } from '../../core/runners/cli-tool-catalog.js';
import {
  resolveCliExecutable,
  resolveCliExecutableAliases,
  resolveCustomExecutable,
} from './resolve-cli-executable.js';
import { cleanupTempDir, createTempDir } from '#testing/helpers/temp-dir.js';

const itUnix = process.platform === 'win32' ? it.skip : it;
const [CURSOR_PRIMARY_EXECUTABLE, CURSOR_FALLBACK_EXECUTABLE] =
  CURSOR_CLI_CANDIDATE.executableAliases;

let dirs: string[] = [];
const originalEnvValues = new Map<string, string | undefined>();

function setEnv(key: string, value: string): void {
  if (!originalEnvValues.has(key)) originalEnvValues.set(key, process.env[key]);
  process.env[key] = value;
}

function makeExecutable(path: string, body = '#!/bin/sh\nexit 0\n'): void {
  writeFileSync(path, body, { mode: 0o755 });
  chmodSync(path, 0o755);
}

function executableIdentityMetadata(identity: CliExecutableIdentity): ExecutableIdentity {
  const metadata = 'executableIdentity' in identity ? identity.executableIdentity : undefined;
  expect(metadata).toEqual({
    canonicalPath: expect.any(String),
    realPath: expect.any(String),
    platformFileId: expect.any(String),
    fingerprint: expect.any(String),
    resolvedAt: expect.any(Number),
  });
  if (
    typeof metadata !== 'object' ||
    metadata === null ||
    !('canonicalPath' in metadata) ||
    typeof metadata.canonicalPath !== 'string' ||
    !('realPath' in metadata) ||
    typeof metadata.realPath !== 'string' ||
    !('platformFileId' in metadata) ||
    typeof metadata.platformFileId !== 'string' ||
    !('fingerprint' in metadata) ||
    typeof metadata.fingerprint !== 'string' ||
    !('resolvedAt' in metadata) ||
    typeof metadata.resolvedAt !== 'number'
  ) {
    throw new Error('Resolved executable identity metadata is missing.');
  }
  return {
    canonicalPath: metadata.canonicalPath,
    realPath: metadata.realPath,
    platformFileId: metadata.platformFileId,
    fingerprint: metadata.fingerprint,
    resolvedAt: metadata.resolvedAt,
  };
}

function failureData(cause: unknown): unknown {
  if (typeof cause !== 'object' || cause === null || !('data' in cause)) return undefined;
  return cause.data;
}

afterEach(() => {
  for (const [key, value] of originalEnvValues) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  originalEnvValues.clear();
  for (const dir of dirs) cleanupTempDir(dir);
  dirs = [];
});

describe('resolveCliExecutable', () => {
  itUnix('rejects a project-local PATH shadow instead of falling through', async () => {
    const projectDir = createTempDir('resolver-project-shadow');
    const systemDir = createTempDir('resolver-system-bin');
    dirs.push(projectDir, systemDir);
    const projectBin = join(projectDir, 'bin');
    mkdirSync(projectBin);
    makeExecutable(join(projectBin, 'vendor-cli'));
    makeExecutable(join(systemDir, 'vendor-cli'));
    setEnv('PATH', [projectBin, systemDir].join(delimiter));

    await expect(
      resolveCliExecutable({ command: 'vendor-cli', projectDir: projectDir }),
    ).rejects.toMatchObject({
      kind: 'cli-executable-untrusted',
    });
  });

  itUnix('rejects empty and relative PATH shadows before an external candidate', async () => {
    const projectDir = createTempDir('resolver-relative-shadow');
    const externalBin = createTempDir('resolver-external-bin');
    const relativeBin = join(projectDir, 'relative-bin');
    dirs.push(projectDir, externalBin);
    mkdirSync(relativeBin);
    makeExecutable(join(projectDir, 'vendor-cli'));
    makeExecutable(join(relativeBin, 'relative-cli'));
    makeExecutable(join(externalBin, 'vendor-cli'));
    makeExecutable(join(externalBin, 'relative-cli'));

    setEnv('PATH', ['', externalBin].join(delimiter));
    await expect(
      resolveCliExecutable({ command: 'vendor-cli', projectDir: projectDir }),
    ).rejects.toMatchObject({
      kind: 'cli-executable-untrusted',
    });

    setEnv('PATH', ['relative-bin', externalBin].join(delimiter));
    await expect(
      resolveCliExecutable({ command: 'relative-cli', projectDir: projectDir }),
    ).rejects.toMatchObject({
      kind: 'cli-executable-untrusted',
    });
  });

  itUnix('binds canonical, real, platform, and fingerprint identity behind a symlink', async () => {
    const projectDir = createTempDir('resolver-identity-project');
    const realBin = createTempDir('resolver-identity-real');
    const linkBin = createTempDir('resolver-identity-link');
    dirs.push(projectDir, realBin, linkBin);
    const executable = join(realBin, 'vendor-cli');
    const linkedExecutable = join(linkBin, 'vendor-cli');
    makeExecutable(executable);
    symlinkSync(executable, linkedExecutable);
    setEnv('PATH', linkBin);

    const identity = await resolveCliExecutable({ command: 'vendor-cli', projectDir: projectDir });
    const realPath = realpathSync(executable);
    const info = statSync(realPath);

    expect(identity.path).toBe(realPath);
    const metadata = executableIdentityMetadata(identity);
    expect(metadata).toMatchObject({
      canonicalPath: linkedExecutable,
      realPath,
      platformFileId: `${info.dev}:${info.ino}`,
      resolvedAt: expect.any(Number),
    });
    expect(metadata.fingerprint).toMatch(
      new RegExp(`^${info.dev}:${info.ino}:${info.size}:${info.mtimeMs}:sha256:[a-f0-9]{64}$`),
    );
  });

  itUnix('reports content replacement as identity drift', async () => {
    const projectDir = createTempDir('resolver-content-drift-project');
    const binDir = createTempDir('resolver-content-drift-bin');
    dirs.push(projectDir, binDir);
    const executable = join(binDir, 'vendor-cli');
    makeExecutable(executable);
    setEnv('PATH', binDir);
    const trusted = await resolveCliExecutable({ command: 'vendor-cli', projectDir: projectDir });
    makeExecutable(executable, '#!/bin/sh\necho replacement\n');

    await expect(
      resolveCliExecutable({ command: 'vendor-cli', projectDir: projectDir, trust: trusted }),
    ).rejects.toMatchObject({
      kind: 'cli-executable-identity-drift',
    });
  });

  itUnix('rejects a same-inode same-size replacement with restored mtime', async () => {
    const projectDir = createTempDir('resolver-preserved-metadata-project');
    const binDir = createTempDir('resolver-preserved-metadata-bin');
    dirs.push(projectDir, binDir);
    const executable = join(binDir, 'vendor-cli');
    const original = '#!/bin/sh\n:     "$0.ran"\nexit 0\n';
    const replacement = '#!/bin/sh\ntouch "$0.ran"\nexit 0\n';
    expect(Buffer.byteLength(original)).toBe(Buffer.byteLength(replacement));
    makeExecutable(executable, original);
    const fixedTime = new Date(1_700_000_000_000);
    utimesSync(executable, fixedTime, fixedTime);
    setEnv('PATH', binDir);
    const trusted = await resolveCliExecutable({ command: 'vendor-cli', projectDir: projectDir });
    const before = statSync(executable);

    writeFileSync(executable, replacement, { mode: 0o755 });
    chmodSync(executable, 0o755);
    utimesSync(executable, fixedTime, fixedTime);
    const after = statSync(executable);

    expect(after.ino).toBe(before.ino);
    expect(after.size).toBe(before.size);
    expect(after.mtimeMs).toBe(before.mtimeMs);
    await expect(
      resolveCliExecutable({ command: 'vendor-cli', projectDir: projectDir, trust: trusted }),
    ).rejects.toMatchObject({
      kind: 'cli-executable-identity-drift',
    });
  });

  itUnix('reports a symlink target replacement as identity drift', async () => {
    const projectDir = createTempDir('resolver-symlink-drift-project');
    const firstBin = createTempDir('resolver-symlink-first');
    const secondBin = createTempDir('resolver-symlink-second');
    const linkBin = createTempDir('resolver-symlink-link');
    dirs.push(projectDir, firstBin, secondBin, linkBin);
    const first = join(firstBin, 'vendor-cli');
    const second = join(secondBin, 'vendor-cli');
    const linkedExecutable = join(linkBin, 'vendor-cli');
    makeExecutable(first);
    makeExecutable(second, '#!/bin/sh\necho second\n');
    symlinkSync(first, linkedExecutable);
    setEnv('PATH', linkBin);
    const trusted = await resolveCliExecutable({ command: 'vendor-cli', projectDir: projectDir });

    unlinkSync(linkedExecutable);
    symlinkSync(second, linkedExecutable);

    await expect(
      resolveCliExecutable({ command: 'vendor-cli', projectDir: projectDir, trust: trusted }),
    ).rejects.toMatchObject({
      kind: 'cli-executable-identity-drift',
    });
  });

  itUnix('reports a PATH replacement or disappearance as identity drift', async () => {
    const projectDir = createTempDir('resolver-path-drift-project');
    const approvedBin = createTempDir('resolver-path-approved');
    const replacementBin = createTempDir('resolver-path-replacement');
    dirs.push(projectDir, approvedBin, replacementBin);
    makeExecutable(join(approvedBin, 'vendor-cli'));
    makeExecutable(join(replacementBin, 'vendor-cli'), '#!/bin/sh\necho replacement\n');
    setEnv('PATH', approvedBin);
    const trusted = await resolveCliExecutable({ command: 'vendor-cli', projectDir: projectDir });

    setEnv('PATH', replacementBin);
    await expect(
      resolveCliExecutable({ command: 'vendor-cli', projectDir: projectDir, trust: trusted }),
    ).rejects.toMatchObject({
      kind: 'cli-executable-identity-drift',
    });

    setEnv('PATH', '');
    await expect(
      resolveCliExecutable({ command: 'vendor-cli', projectDir: projectDir, trust: trusted }),
    ).rejects.toMatchObject({
      kind: 'cli-executable-identity-drift',
    });
  });

  itUnix('admits an exact trusted identity for a project-local executable only', async () => {
    const trustedRoot = createTempDir('resolver-trusted-project');
    const neutralProject = createTempDir('resolver-neutral-project');
    dirs.push(trustedRoot, neutralProject);
    const binDir = join(trustedRoot, 'bin');
    mkdirSync(binDir);
    makeExecutable(join(binDir, 'vendor-cli'));
    setEnv('PATH', binDir);
    const trust = await resolveCliExecutable({ command: 'vendor-cli', projectDir: neutralProject });

    await expect(
      resolveCliExecutable({ command: 'vendor-cli', projectDir: trustedRoot }),
    ).rejects.toMatchObject({
      kind: 'cli-executable-untrusted',
    });
    const resolved = await resolveCliExecutable({
      command: 'vendor-cli',
      projectDir: trustedRoot,
      trust: trust,
    });
    expect(resolved.path).toBe(trust.path);
    expect(resolved.fingerprint).toEqual(trust.fingerprint);
    const trustedMetadata = executableIdentityMetadata(trust);
    expect(executableIdentityMetadata(resolved)).toMatchObject({
      canonicalPath: trustedMetadata.canonicalPath,
      realPath: trustedMetadata.realPath,
      platformFileId: trustedMetadata.platformFileId,
      fingerprint: trustedMetadata.fingerprint,
    });
  });

  itUnix('redacts absolute paths from unavailable and untrusted diagnostics', async () => {
    const projectDir = createTempDir('resolver-diagnostic-project');
    dirs.push(projectDir);
    const unavailable = join(projectDir, 'private', 'missing-cli');
    const untrusted = join(projectDir, 'private', 'shadow-cli');
    mkdirSync(join(projectDir, 'private'));
    makeExecutable(untrusted);

    let unavailableFailure: unknown;
    try {
      await resolveCliExecutable({ command: unavailable, projectDir: projectDir });
    } catch (cause) {
      unavailableFailure = cause;
    }
    let untrustedFailure: unknown;
    try {
      await resolveCliExecutable({ command: untrusted, projectDir: projectDir });
    } catch (cause) {
      untrustedFailure = cause;
    }

    expect(unavailableFailure).toBeInstanceOf(Error);
    expect((unavailableFailure as Error).message).not.toContain(projectDir);
    expect(JSON.stringify(failureData(unavailableFailure))).not.toContain(projectDir);
    expect((unavailableFailure as Error).message).toContain('missing-cli');
    expect(failureData(unavailableFailure)).toMatchObject({ command: 'missing-cli' });
    expect(untrustedFailure).toBeInstanceOf(Error);
    expect((untrustedFailure as Error).message).not.toContain(projectDir);
    expect(JSON.stringify(failureData(untrustedFailure))).not.toContain(projectDir);
    expect((untrustedFailure as Error).message).toContain('shadow-cli');
    expect(failureData(untrustedFailure)).toMatchObject({
      command: 'shadow-cli',
      identity: { fingerprint: { size: expect.any(Number) } },
    });
  });

  itUnix('redacts absolute paths while preserving drift fingerprints', async () => {
    const projectDir = createTempDir('resolver-diagnostic-drift-project');
    const binDir = createTempDir('resolver-diagnostic-drift-bin');
    dirs.push(projectDir, binDir);
    const command = join(binDir, 'drift-cli');
    makeExecutable(command);
    const trusted = await resolveCliExecutable({ command: command, projectDir: projectDir });
    makeExecutable(command, '#!/bin/sh\necho changed identity\n');

    let caught: unknown;
    try {
      await resolveCliExecutable({ command: command, projectDir: projectDir, trust: trusted });
    } catch (cause) {
      caught = cause;
    }

    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).not.toContain(projectDir);
    expect(JSON.stringify(failureData(caught))).not.toContain(projectDir);
    expect((caught as Error).message).toContain('drift-cli');
    expect(failureData(caught)).toMatchObject({
      command: 'drift-cli',
      expectedIdentity: { fingerprint: trusted.fingerprint },
      actualIdentity: { fingerprint: expect.any(Object) },
    });
  });
});

describe('resolveCliExecutableAliases', () => {
  itUnix(
    'prefers the non-admitted Cursor candidate primary alias without admitting a runner',
    async () => {
      const projectDir = createTempDir('resolver-alias-primary-project');
      const binDir = createTempDir('resolver-alias-primary-bin');
      dirs.push(projectDir, binDir);
      makeExecutable(join(binDir, CURSOR_PRIMARY_EXECUTABLE));
      makeExecutable(join(binDir, CURSOR_FALLBACK_EXECUTABLE));
      setEnv('PATH', binDir);

      const resolved = await resolveCliExecutableAliases({
        commands: CURSOR_CLI_CANDIDATE.executableAliases,
        projectDir,
      });

      expect(resolved.command).toBe(CURSOR_PRIMARY_EXECUTABLE);
      expect(resolved.usedFallback).toBe(false);
      expect(resolved.executable.path).toBe(realpathSync(join(binDir, CURSOR_PRIMARY_EXECUTABLE)));
    },
  );

  itUnix(
    'uses the non-admitted Cursor candidate fallback only after its primary is absent',
    async () => {
      const projectDir = createTempDir('resolver-alias-fallback-project');
      const binDir = createTempDir('resolver-alias-fallback-bin');
      dirs.push(projectDir, binDir);
      makeExecutable(join(binDir, CURSOR_FALLBACK_EXECUTABLE));
      setEnv('PATH', binDir);

      const resolved = await resolveCliExecutableAliases({
        commands: CURSOR_CLI_CANDIDATE.executableAliases,
        projectDir,
      });

      expect(resolved.command).toBe(CURSOR_FALLBACK_EXECUTABLE);
      expect(resolved.usedFallback).toBe(true);
      expect(resolved.executable.path).toBe(realpathSync(join(binDir, CURSOR_FALLBACK_EXECUTABLE)));
    },
  );

  itUnix('keeps a candidate fallback trust valid while its primary remains absent', async () => {
    const projectDir = createTempDir('resolver-alias-trusted-fallback-project');
    const binDir = createTempDir('resolver-alias-trusted-fallback-bin');
    dirs.push(projectDir, binDir);
    makeExecutable(join(binDir, CURSOR_FALLBACK_EXECUTABLE));
    setEnv('PATH', binDir);
    const trust = await resolveCliExecutable({
      command: CURSOR_FALLBACK_EXECUTABLE,
      projectDir: projectDir,
    });

    const resolved = await resolveCliExecutableAliases({
      commands: CURSOR_CLI_CANDIDATE.executableAliases,
      projectDir,
      trust,
    });

    expect(resolved.command).toBe(CURSOR_FALLBACK_EXECUTABLE);
    expect(resolved.usedFallback).toBe(true);
    expect(resolved.executable.path).toBe(trust.path);
  });

  itUnix(
    'does not switch a candidate to its fallback when a newly present primary fails trust',
    async () => {
      const projectDir = createTempDir('resolver-alias-primary-drift-project');
      const binDir = createTempDir('resolver-alias-primary-drift-bin');
      dirs.push(projectDir, binDir);
      makeExecutable(join(binDir, CURSOR_FALLBACK_EXECUTABLE));
      setEnv('PATH', binDir);
      const trust = await resolveCliExecutable({
        command: CURSOR_FALLBACK_EXECUTABLE,
        projectDir: projectDir,
      });
      makeExecutable(join(binDir, CURSOR_PRIMARY_EXECUTABLE));

      await expect(
        resolveCliExecutableAliases({
          commands: CURSOR_CLI_CANDIDATE.executableAliases,
          projectDir,
          trust,
        }),
      ).rejects.toMatchObject({ kind: 'cli-executable-identity-drift' });
    },
  );
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
    ).resolves.toEqual({ kind: 'identity-drifted' });
  });
});
