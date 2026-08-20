import { chmodSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { CliExecutableReceipt } from '../../core/discovery/detection.js';
import { bindCompilerRuntimeEvidence } from './compiler-runtime-evidence.js';
import { resolveCustomExecutable } from './resolve-cli-executable.js';
import { cleanupTempDir, createTempDir } from '#testing/helpers/temp-dir.js';

const itUnix = process.platform === 'win32' ? it.skip : it;

let dirs: string[] = [];

function makeExecutable(path: string, body = '#!/bin/sh\nexit 0\n'): void {
  writeFileSync(path, body, { mode: 0o755 });
  chmodSync(path, 0o755);
}

afterEach(() => {
  for (const dir of dirs) cleanupTempDir(dir);
  dirs = [];
});

describe('bindCompilerRuntimeEvidence', () => {
  itUnix(
    'binds the exact admitted runtime and protocol once with a deterministic digest',
    async () => {
      const projectDir = createTempDir('compiler-bind-exact-project');
      const binDir = createTempDir('compiler-bind-exact-bin');
      dirs.push(projectDir, binDir);
      makeExecutable(join(binDir, 'vendor-cli'));
      const resolution = await resolveCustomExecutable({
        command: join(binDir, 'vendor-cli'),
        projectDir,
      });
      expect(resolution.kind).toBe('resolved');
      if (resolution.kind !== 'resolved') return;

      const first = bindCompilerRuntimeEvidence({
        backend: 'opencode',
        executable: resolution.executable,
        version: '1.18.15',
      });
      const second = bindCompilerRuntimeEvidence({
        backend: 'opencode',
        executable: resolution.executable,
        version: '1.18.15',
      });

      expect(first.kind).toBe('bound');
      expect(second.kind).toBe('bound');
      if (first.kind !== 'bound' || second.kind !== 'bound') return;
      expect(first.evidence).toEqual(second.evidence);
      expect(first.evidence).toMatchObject({
        backend: 'opencode',
        version: '1.18.15',
        runtimeVersion: '1.18.15',
        versionObservation: 'tested',
        transports: ['stdout-final'],
        terminalContract: 'opencode-final-message-v1',
        fixtureDate: '2026-08-15',
        executable: { path: resolution.executable.path },
      });
      expect(first.evidence.evidenceDigest).toMatch(/^[0-9a-f]{64}$/u);
    },
  );

  itUnix('binds a drifted supported runtime with drift evidence', async () => {
    const projectDir = createTempDir('compiler-bind-drift-project');
    const binDir = createTempDir('compiler-bind-drift-bin');
    dirs.push(projectDir, binDir);
    makeExecutable(join(binDir, 'vendor-cli'));
    const resolution = await resolveCustomExecutable({
      command: join(binDir, 'vendor-cli'),
      projectDir,
    });
    expect(resolution.kind).toBe('resolved');
    if (resolution.kind !== 'resolved') return;

    const exact = bindCompilerRuntimeEvidence({
      backend: 'claude-code',
      executable: resolution.executable,
      version: '2.1.232',
    });
    const drifted = bindCompilerRuntimeEvidence({
      backend: 'claude-code',
      executable: resolution.executable,
      version: '2.1.235',
    });

    expect(drifted.kind).toBe('bound');
    if (drifted.kind !== 'bound' || exact.kind !== 'bound') return;
    expect(drifted.evidence).toMatchObject({
      backend: 'claude-code',
      version: '2.1.232',
      runtimeVersion: '2.1.235',
      versionObservation: 'drifted',
      transports: ['stdout-final'],
      terminalContract: 'claude-terminal-result-v1',
      fixtureDate: '2026-08-15',
      executable: { path: resolution.executable.path },
    });
    expect(drifted.evidence.evidenceDigest).toMatch(/^[0-9a-f]{64}$/u);
    expect(drifted.evidence.evidenceDigest).not.toBe(exact.evidence.evidenceDigest);
  });

  itUnix.each(['1.18.14', '1.18.16', '1.19.0', '1.18.15-beta.1', 'latest', ''])(
    'binds installed version "%s" with drift observation',
    async (installedVersion) => {
      const projectDir = createTempDir('compiler-bind-version-project');
      const binDir = createTempDir('compiler-bind-version-bin');
      dirs.push(projectDir, binDir);
      makeExecutable(join(binDir, 'vendor-cli'));
      const resolution = await resolveCustomExecutable({
        command: join(binDir, 'vendor-cli'),
        projectDir,
      });
      expect(resolution.kind).toBe('resolved');
      if (resolution.kind !== 'resolved') return;

      const admission = bindCompilerRuntimeEvidence({
        backend: 'opencode',
        executable: resolution.executable,
        version: installedVersion,
      });

      expect(admission.kind).toBe('bound');
      if (admission.kind !== 'bound') return;
      expect(admission.evidence.versionObservation).toBe('drifted');
      expect(admission.evidence.runtimeVersion).toBe(installedVersion);
      expect(admission.evidence.version).toBe('1.18.15');
    },
  );

  itUnix.each(['copilot', 'aider', 'shell', 'agent'] as const)(
    'refuses unsupported backend %s even with the claimed exact version',
    async (backend) => {
      const projectDir = createTempDir('compiler-bind-backend-project');
      const binDir = createTempDir('compiler-bind-backend-bin');
      dirs.push(projectDir, binDir);
      makeExecutable(join(binDir, 'vendor-cli'));
      const resolution = await resolveCustomExecutable({
        command: join(binDir, 'vendor-cli'),
        projectDir,
      });
      expect(resolution.kind).toBe('resolved');
      if (resolution.kind !== 'resolved') return;

      const admission = bindCompilerRuntimeEvidence({
        backend,
        executable: resolution.executable,
        version: '1.18.15',
      });

      expect(admission.kind).toBe('refused');
      if (admission.kind !== 'refused') return;
      expect(admission.failure.code).toBe('task_compiler_capability_unsupported');
      expect(admission.failure.message).toContain(backend);
      expect(admission.missing).toEqual(['backend']);
    },
  );

  itUnix('refuses an executable that is not a digest-bound receipt', async () => {
    const admission = bindCompilerRuntimeEvidence({
      backend: 'opencode',
      executable: {
        path: '/fake/executable',
        fingerprint: { dev: 1, ino: 2, size: 3, mtimeMs: 4 },
      } as unknown as CliExecutableReceipt,
      version: '1.18.15',
    });

    expect(admission.kind).toBe('refused');
    if (admission.kind !== 'refused') return;
    expect(admission.failure.code).toBe('task_compiler_capability_unsupported');
    expect(admission.missing).toEqual(['executable']);
  });
});
