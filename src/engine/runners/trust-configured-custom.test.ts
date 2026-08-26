import { describe, expect, it } from 'vitest';
import { chmodSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { CustomCommand } from '../../core/config/custom-commands.js';
import {
  admitCustomRunner,
  revalidateCustomRunnerInvocation,
  resolveCustomRunnerLaunchability,
} from './custom-launchability.js';
import { customRunnerSecurityPosture, markCustomRunnerTrusted } from './custom-trust.js';
import { resolveCustomExecutable } from './resolve-cli-executable.js';

function customCommand(overrides: Partial<CustomCommand> = {}): CustomCommand {
  return {
    id: 'review',
    label: 'Review changes',
    contract: 'output',
    executable: process.execPath,
    argv: ['--review'],
    outputFormat: 'text',
    idleWarnMs: 300_000,
    idleKillMs: 1_800_000,
    env: [],
    ...overrides,
  };
}

function configuredRunner(command = customCommand()) {
  return { source: 'configured' as const, command };
}

describe('custom runner launchability', () => {
  it('moves from resolved to trusted and invalidates a changed definition', async () => {
    const projectDir = mkdtempSync(join(tmpdir(), 'splitbrief-custom-launch-project-'));
    const stateDir = mkdtempSync(join(tmpdir(), 'splitbrief-custom-launch-state-'));
    try {
      const posture = customRunnerSecurityPosture('planner', 'output');
      await expect(
        resolveCustomRunnerLaunchability({
          projectDir,
          runner: configuredRunner(),
          posture,
          stateDir,
        }),
      ).resolves.toMatchObject({ kind: 'resolved' });
      const executable = await resolveCustomExecutable({ command: process.execPath, projectDir });
      expect(executable.kind).toBe('resolved');
      if (executable.kind !== 'resolved') throw new Error('Node executable did not resolve');
      await markCustomRunnerTrusted({
        projectDir,
        runner: configuredRunner(),
        posture,
        executable: executable.executable,
        stateDir,
      });

      await expect(
        resolveCustomRunnerLaunchability({
          projectDir,
          runner: configuredRunner(),
          posture,
          stateDir,
        }),
      ).resolves.toMatchObject({ kind: 'trusted' });
      await expect(
        resolveCustomRunnerLaunchability({
          projectDir,
          runner: configuredRunner(customCommand({ label: 'Changed label' })),
          posture,
          stateDir,
        }),
      ).resolves.toMatchObject({ kind: 'untrusted' });
    } finally {
      rmSync(projectDir, { recursive: true, force: true });
      rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it('distinguishes missing, non-executable, drifted, and invalid definitions', async () => {
    const projectDir = mkdtempSync(join(tmpdir(), 'splitbrief-custom-status-project-'));
    const stateDir = mkdtempSync(join(tmpdir(), 'splitbrief-custom-status-state-'));
    try {
      const posture = customRunnerSecurityPosture('planner', 'output');
      await expect(
        resolveCustomRunnerLaunchability({
          projectDir,
          runner: configuredRunner(customCommand({ executable: join(projectDir, 'missing') })),
          posture,
          stateDir,
        }),
      ).resolves.toEqual({ kind: 'missing' });

      const nonExecutable = join(projectDir, 'non-executable');
      writeFileSync(nonExecutable, '#!/bin/sh\nexit 0\n', { mode: 0o600 });
      chmodSync(nonExecutable, 0o600);
      await expect(
        resolveCustomRunnerLaunchability({
          projectDir,
          runner: configuredRunner(customCommand({ executable: nonExecutable })),
          posture,
          stateDir,
        }),
      ).resolves.toEqual({ kind: 'non-executable' });

      const drifted = join(projectDir, 'drifted');
      writeFileSync(drifted, '#!/bin/sh\necho original\n', { mode: 0o755 });
      chmodSync(drifted, 0o755);
      const driftedCommand = customCommand({ executable: drifted });
      const resolved = await resolveCustomExecutable({ command: drifted, projectDir });
      expect(resolved.kind).toBe('resolved');
      if (resolved.kind !== 'resolved') throw new Error('drift fixture did not resolve');
      await markCustomRunnerTrusted({
        projectDir,
        runner: configuredRunner(driftedCommand),
        posture,
        executable: resolved.executable,
        stateDir,
      });
      writeFileSync(drifted, '#!/bin/sh\necho replacement\n', { mode: 0o755 });
      chmodSync(drifted, 0o755);
      await expect(
        resolveCustomRunnerLaunchability({
          projectDir,
          runner: configuredRunner(driftedCommand),
          posture,
          stateDir,
        }),
      ).resolves.toEqual({ kind: 'drifted' });

      await expect(
        resolveCustomRunnerLaunchability({
          projectDir,
          runner: { source: 'legacy-unsafe', opaqueId: 'legacy-unsafe-1' },
          posture,
          stateDir,
        }),
      ).resolves.toEqual({ kind: 'invalid' });
    } finally {
      rmSync(projectDir, { recursive: true, force: true });
      rmSync(stateDir, { recursive: true, force: true });
    }
  });
});

describe('custom runner admission', () => {
  it('blocks headless use without a grant or receipt and carries the exact runner in every admission', async () => {
    const projectDir = mkdtempSync(join(tmpdir(), 'splitbrief-custom-admit-project-'));
    const stateDir = mkdtempSync(join(tmpdir(), 'splitbrief-custom-admit-state-'));
    try {
      const runner = configuredRunner();
      const options = {
        projectDir,
        runner,
        posture: customRunnerSecurityPosture('implementer', 'output'),
        stateDir,
      };
      await expect(
        admitCustomRunner({ ...options, interaction: 'headless', grant: false }),
      ).resolves.toEqual({ kind: 'denied', status: 'resolved' });
      await expect(
        admitCustomRunner({ ...options, interaction: 'interactive', grant: false }),
      ).resolves.toMatchObject({
        kind: 'disclosure-required',
        disclosure: {
          contract: 'output',
          filesystem: expect.stringContaining('Not an OS sandbox'),
          network: expect.stringContaining('not restricted'),
        },
      });
      const explicitGrant = await admitCustomRunner({
        ...options,
        interaction: 'headless',
        grant: true,
      });
      expect(explicitGrant).toMatchObject({
        kind: 'admitted',
        invocation: {
          kind: 'custom-runner-invocation',
          authorization: 'explicit-grant',
          posture: options.posture,
        },
      });
      if (explicitGrant.kind !== 'admitted')
        throw new Error('Custom runner grant was not admitted');
      expect(explicitGrant.invocation.runner).toEqual(runner);
      expect(explicitGrant.invocation.scope).toMatchObject({ definitionId: runner.command.id });

      const executable = await resolveCustomExecutable({ command: process.execPath, projectDir });
      expect(executable.kind).toBe('resolved');
      if (executable.kind !== 'resolved') throw new Error('Node executable did not resolve');
      await markCustomRunnerTrusted({
        ...options,
        executable: executable.executable,
      });
      const receiptAdmission = await admitCustomRunner({
        ...options,
        interaction: 'headless',
        grant: false,
      });
      expect(receiptAdmission).toMatchObject({
        kind: 'admitted',
        invocation: {
          kind: 'custom-runner-invocation',
          authorization: 'receipt',
          posture: options.posture,
        },
      });
      if (receiptAdmission.kind !== 'admitted')
        throw new Error('Custom runner receipt was not admitted');
      expect(receiptAdmission.invocation.runner).toEqual(runner);
      expect(receiptAdmission.invocation.scope).toMatchObject({ definitionId: runner.command.id });
    } finally {
      rmSync(projectDir, { recursive: true, force: true });
      rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it('rejects an invocation whose project, definition, posture, or executable changed after admission', async () => {
    const projectDir = mkdtempSync(join(tmpdir(), 'splitbrief-custom-invocation-project-'));
    const otherProjectDir = mkdtempSync(join(tmpdir(), 'splitbrief-custom-invocation-other-'));
    const stateDir = mkdtempSync(join(tmpdir(), 'splitbrief-custom-invocation-state-'));
    try {
      const executablePath = join(projectDir, 'custom-runner');
      writeFileSync(executablePath, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
      chmodSync(executablePath, 0o755);
      const runner = configuredRunner(customCommand({ executable: executablePath, argv: [] }));
      const posture = customRunnerSecurityPosture('implementer', 'output');
      const admitted = await admitCustomRunner({
        projectDir,
        runner,
        posture,
        stateDir,
        interaction: 'headless',
        grant: true,
      });
      expect(admitted).toMatchObject({ kind: 'admitted' });
      if (admitted.kind !== 'admitted') throw new Error('Custom runner was not admitted');
      const invocation = admitted.invocation;

      await expect(
        revalidateCustomRunnerInvocation({ invocation, projectDir }),
      ).resolves.toMatchObject({ path: realpathSync(executablePath) });
      await expect(
        revalidateCustomRunnerInvocation({ invocation, projectDir: otherProjectDir }),
      ).rejects.toMatchObject({ kind: 'custom-runner-admission-scope-mismatch' });
      await expect(
        revalidateCustomRunnerInvocation({
          invocation: {
            ...invocation,
            runner: configuredRunner(
              customCommand({ executable: executablePath, argv: [], label: 'Changed' }),
            ),
          },
          projectDir,
        }),
      ).rejects.toMatchObject({ kind: 'custom-runner-admission-scope-mismatch' });
      await expect(
        revalidateCustomRunnerInvocation({
          invocation: {
            ...invocation,
            posture: customRunnerSecurityPosture('planner', 'output'),
          },
          projectDir,
        }),
      ).rejects.toMatchObject({ kind: 'custom-runner-admission-scope-mismatch' });

      writeFileSync(executablePath, '#!/bin/sh\necho replaced\n', { mode: 0o755 });
      chmodSync(executablePath, 0o755);
      await expect(
        revalidateCustomRunnerInvocation({ invocation, projectDir }),
      ).rejects.toMatchObject({ kind: 'custom-runner-executable-drifted' });
    } finally {
      rmSync(projectDir, { recursive: true, force: true });
      rmSync(otherProjectDir, { recursive: true, force: true });
      rmSync(stateDir, { recursive: true, force: true });
    }
  });
});
