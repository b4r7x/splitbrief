import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { CustomCommand } from '../../core/config/custom-commands.js';
import type { CliExecutableReceipt } from '../../core/discovery/detection.js';
import { cleanupTempDir, createTempDir } from '#testing/helpers/temp-dir.js';
import { buildCustomRunnerDisclosure } from './custom-runner-disclosure.js';
import {
  customRunnerSecurityPosture,
  inlineRunnerSecurityPosture,
  markCustomRunnerTrusted,
  readCustomRunnerTrust,
  resolveCustomRunnerAdmissionScope,
  resolveCustomRunnerTrustFile,
} from './custom-trust.js';
import { resolveCustomExecutable } from './resolve-cli-executable.js';

const itUnix = process.platform === 'win32' ? it.skip : it;
let directories: string[] = [];

const DISCLOSURE_EXECUTABLE = {
  path: '/opt/splitbrief/bin/disclosure-runner',
  fingerprint: { dev: 1, ino: 2, size: 3, mtimeMs: 4 },
  executableIdentity: {
    canonicalPath: '/opt/splitbrief/bin/disclosure-runner',
    realPath: '/opt/splitbrief/bin/disclosure-runner',
    platformFileId: '1:2',
    fingerprint: '1:2:3:4:sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    resolvedAt: 5,
  },
} satisfies CliExecutableReceipt;

function command(overrides: Partial<CustomCommand> = {}): CustomCommand {
  return {
    id: 'review',
    label: 'Review changes',
    contract: 'output',
    executable: process.execPath,
    argv: ['--input', 'task.md'],
    outputFormat: 'text',
    idleWarnMs: 300_000,
    idleKillMs: 1_800_000,
    env: ['REVIEW_TOKEN'],
    ...overrides,
  };
}

function runner(customCommand = command()) {
  return { source: 'configured' as const, command: customCommand };
}

async function executable(projectDir: string) {
  const resolution = await resolveCustomExecutable({ command: process.execPath, projectDir });
  if (resolution.kind !== 'resolved') throw new Error('Node executable did not resolve');
  return resolution.executable;
}

afterEach(() => {
  for (const directory of directories) cleanupTempDir(directory);
  directories = [];
});

describe('custom runner trust receipts', () => {
  it('derives one stable admission scope that changes with project, definition, or posture', async () => {
    const projectDir = createTempDir('custom-trust-scope-project');
    const otherProjectDir = createTempDir('custom-trust-scope-other-project');
    directories.push(projectDir, otherProjectDir);
    const configuredRunner = runner();
    const plannerPosture = customRunnerSecurityPosture('planner', 'output');
    const first = await resolveCustomRunnerAdmissionScope({
      projectDir,
      runner: configuredRunner,
      posture: plannerPosture,
    });
    const second = await resolveCustomRunnerAdmissionScope({
      projectDir,
      runner: configuredRunner,
      posture: plannerPosture,
    });

    expect(first).not.toBeNull();
    expect(second).toEqual(first);
    if (first === null) throw new Error('Custom runner scope did not resolve');
    await expect(
      resolveCustomRunnerAdmissionScope({
        projectDir: otherProjectDir,
        runner: configuredRunner,
        posture: plannerPosture,
      }),
    ).resolves.not.toEqual(first);
    await expect(
      resolveCustomRunnerAdmissionScope({
        projectDir,
        runner: runner(command({ label: 'Changed command' })),
        posture: plannerPosture,
      }),
    ).resolves.not.toEqual(first);
    await expect(
      resolveCustomRunnerAdmissionScope({
        projectDir,
        runner: configuredRunner,
        posture: customRunnerSecurityPosture('implementer', 'output'),
      }),
    ).resolves.not.toEqual(first);
  });

  itUnix('writes owner-only user-local state and never changes project YAML', async () => {
    const projectDir = createTempDir('custom-trust-project');
    const stateDir = createTempDir('custom-trust-user-state');
    directories.push(projectDir, stateDir);
    const configDir = join(projectDir, '.splitbrief');
    const configPath = join(configDir, 'config.yaml');
    mkdirSync(configDir);
    writeFileSync(configPath, 'version: 3\n# project sentinel\n', { mode: 0o600 });
    const before = readFileSync(configPath, 'utf8');
    const posture = customRunnerSecurityPosture('planner', 'output');

    const marked = await markCustomRunnerTrusted({
      projectDir,
      runner: runner(),
      posture,
      executable: await executable(projectDir),
      stateDir,
      now: () => 123,
    });

    expect(marked).toMatchObject({ kind: 'trusted', receipt: { trustedAt: 123 } });
    const trustPath = resolveCustomRunnerTrustFile(stateDir);
    expect(trustPath.startsWith(`${stateDir}/`)).toBe(true);
    expect(trustPath.startsWith(`${projectDir}/`)).toBe(false);
    expect(statSync(stateDir).mode & 0o777).toBe(0o700);
    expect(statSync(trustPath).mode & 0o777).toBe(0o600);
    expect(readFileSync(configPath, 'utf8')).toBe(before);
    expect(existsSync(join(projectDir, '.splitbrief', 'custom-runners.json'))).toBe(false);
    await expect(
      readCustomRunnerTrust({ projectDir, runner: runner(), posture, stateDir }),
    ).resolves.toMatchObject({ kind: 'match' });
  });

  it('checks cancellation at the final boundary before publishing trust', async () => {
    const projectDir = createTempDir('custom-trust-abort-before-write-project');
    const stateDir = createTempDir('custom-trust-abort-before-write-state');
    directories.push(projectDir, stateDir);
    const controller = new AbortController();

    await expect(
      markCustomRunnerTrusted({
        projectDir,
        runner: runner(),
        posture: customRunnerSecurityPosture('planner', 'output'),
        executable: await executable(projectDir),
        stateDir,
        signal: controller.signal,
        _beforeWrite: () => controller.abort(),
      }),
    ).rejects.toMatchObject({ name: 'AbortError' });

    expect(existsSync(resolveCustomRunnerTrustFile(stateDir))).toBe(false);
  });

  it('reports a successful publication when cancellation arrives after the durable write', async () => {
    const projectDir = createTempDir('custom-trust-abort-after-write-project');
    const stateDir = createTempDir('custom-trust-abort-after-write-state');
    directories.push(projectDir, stateDir);
    const controller = new AbortController();

    const marked = await markCustomRunnerTrusted({
      projectDir,
      runner: runner(),
      posture: customRunnerSecurityPosture('planner', 'output'),
      executable: await executable(projectDir),
      stateDir,
      signal: controller.signal,
      _afterWrite: () => controller.abort(),
    });

    expect(marked).toMatchObject({ kind: 'trusted', abortedAfterPublication: true });
    expect(existsSync(resolveCustomRunnerTrustFile(stateDir))).toBe(true);
    await expect(
      readCustomRunnerTrust({
        projectDir,
        runner: runner(),
        posture: customRunnerSecurityPosture('planner', 'output'),
        stateDir,
      }),
    ).resolves.toMatchObject({ kind: 'match' });
  });

  it('invalidates every definition and security-posture field', async () => {
    const projectDir = createTempDir('custom-trust-invalidation-project');
    const stateDir = createTempDir('custom-trust-invalidation-state');
    directories.push(projectDir, stateDir);
    const baseCommand = command();
    const basePosture = customRunnerSecurityPosture('planner', 'output');
    await markCustomRunnerTrusted({
      projectDir,
      runner: runner(baseCommand),
      posture: basePosture,
      executable: await executable(projectDir),
      stateDir,
    });

    const cases: Array<{ customCommand: CustomCommand; posture: unknown }> = [
      { customCommand: command({ id: 'review-two' }), posture: basePosture },
      { customCommand: command({ label: 'Review again' }), posture: basePosture },
      {
        customCommand: command({ contract: 'direct' }),
        posture: customRunnerSecurityPosture('planner', 'direct'),
      },
      { customCommand: command({ executable: '/different/executable' }), posture: basePosture },
      { customCommand: command({ argv: ['--changed'] }), posture: basePosture },
      { customCommand: command({ outputFormat: 'jsonl' }), posture: basePosture },
      { customCommand: command({ idleWarnMs: 299_999 }), posture: basePosture },
      { customCommand: command({ idleKillMs: 1_799_999 }), posture: basePosture },
      { customCommand: command({ env: ['OTHER_TOKEN'] }), posture: basePosture },
      {
        customCommand: baseCommand,
        posture: customRunnerSecurityPosture('implementer', 'output'),
      },
      { customCommand: baseCommand, posture: { ...basePosture, cwd: 'real-project' } },
      { customCommand: baseCommand, posture: { ...basePosture, stage: 'unfiltered-project' } },
      { customCommand: baseCommand, posture: { ...basePosture, filesystem: 'sandboxed' } },
      { customCommand: baseCommand, posture: { ...basePosture, network: 'blocked' } },
      { customCommand: baseCommand, posture: { ...basePosture, result: 'raw-process-output' } },
    ];

    for (const changed of cases) {
      const lookup = await readCustomRunnerTrust({
        projectDir,
        runner: runner(changed.customCommand),
        posture: changed.posture,
        stateDir,
      });
      expect(lookup.kind).not.toBe('match');
    }
  });

  itUnix('binds trust to the canonical project identity', async () => {
    const projectDir = createTempDir('custom-trust-canonical-project');
    const linkParent = createTempDir('custom-trust-canonical-link');
    const stateDir = createTempDir('custom-trust-canonical-state');
    directories.push(projectDir, linkParent, stateDir);
    const linkedProjectDir = join(linkParent, 'project-link');
    symlinkSync(projectDir, linkedProjectDir, 'dir');
    const posture = customRunnerSecurityPosture('planner', 'output');

    await markCustomRunnerTrusted({
      projectDir: linkedProjectDir,
      runner: runner(),
      posture,
      executable: await executable(linkedProjectDir),
      stateDir,
    });

    await expect(
      readCustomRunnerTrust({ projectDir, runner: runner(), posture, stateDir }),
    ).resolves.toMatchObject({ kind: 'match' });
  });

  itUnix('rejects malformed or non-owner-only receipt state', async () => {
    const projectDir = createTempDir('custom-trust-invalid-project');
    const stateDir = createTempDir('custom-trust-invalid-state');
    directories.push(projectDir, stateDir);
    const path = resolveCustomRunnerTrustFile(stateDir);
    writeFileSync(path, '{"version":1,"receipts":[]}', { mode: 0o644 });
    chmodSync(path, 0o644);

    await expect(
      readCustomRunnerTrust({
        projectDir,
        runner: runner(),
        posture: customRunnerSecurityPosture('planner', 'output'),
        stateDir,
      }),
    ).resolves.toEqual({ kind: 'invalid' });
  });

  it('never hashes or persists unsafe legacy material', async () => {
    const projectDir = createTempDir('custom-trust-unsafe-project');
    const stateDir = createTempDir('custom-trust-unsafe-state');
    directories.push(projectDir, stateDir);
    const credential = 'ghp_this_must_never_be_hashed_or_persisted';

    const result = await markCustomRunnerTrusted({
      projectDir,
      runner: {
        source: 'legacy-unsafe',
        opaqueId: 'legacy-unsafe-1',
        raw: credential,
      },
      posture: customRunnerSecurityPosture('planner', 'output'),
      executable: await executable(projectDir),
      stateDir,
    });

    expect(result).toEqual({ kind: 'invalid' });
    expect(existsSync(resolveCustomRunnerTrustFile(stateDir))).toBe(false);
    expect(JSON.stringify(result)).not.toContain(credential);
  });
});

describe('custom runner security posture', () => {
  it('freezes the posture and definition digest for every role and invocation shape', async () => {
    const projectDir = createTempDir('custom-trust-posture-project');
    directories.push(projectDir);
    const rows = [
      {
        role: 'planner',
        contract: 'output',
        posture: {
          role: 'planner',
          source: 'configured',
          cwd: 'disposable-stage',
          stage: 'filtered-disposable-stage',
          environmentAccess: 'declared-references-only',
          filesystem: 'host-user-access',
          network: 'host-network-access',
          result: 'parsed-output-only',
        },
        definitionDigest: 'sha256:af1e547965278cc54ebe6a49a61099cb341bdca051ef91abd4d970d00a3caa93',
      },
      {
        role: 'planner',
        contract: 'direct',
        posture: {
          role: 'planner',
          source: 'configured',
          cwd: 'disposable-stage',
          stage: 'filtered-disposable-stage',
          environmentAccess: 'declared-references-only',
          filesystem: 'host-user-access',
          network: 'host-network-access',
          result: 'reviewed-declared-artifact-or-workspace-diff-only',
        },
        definitionDigest: 'sha256:ffb803325c3a591ada4b1b42bc21ff67eb3a5512da6d7b6f9abb100b782b74c0',
      },
      {
        role: 'implementer',
        contract: 'output',
        posture: {
          role: 'implementer',
          source: 'configured',
          cwd: 'disposable-stage',
          stage: 'filtered-disposable-stage',
          environmentAccess: 'declared-references-only',
          filesystem: 'host-user-access',
          network: 'host-network-access',
          result: 'parsed-output-only',
        },
        definitionDigest: 'sha256:eaae5f48b91af309522e855faa82203ea9601ebb02acd490cc955dca3b4efea0',
      },
      {
        role: 'implementer',
        contract: 'direct',
        posture: {
          role: 'implementer',
          source: 'configured',
          cwd: 'disposable-stage',
          stage: 'filtered-disposable-stage',
          environmentAccess: 'declared-references-only',
          filesystem: 'host-user-access',
          network: 'host-network-access',
          result: 'reviewed-diff-only',
        },
        definitionDigest: 'sha256:9035a689b22fbcf8f50ec490cfcb77428fed1aca0c80d14061b5aa290f5ffc1a',
      },
    ] as const;
    const definitionDigests: string[] = [];

    for (const row of rows) {
      const configuredRunner = runner(
        command({
          id: 'disclosure-fixture',
          label: 'Disclosure fixture runner',
          contract: row.contract,
          executable: DISCLOSURE_EXECUTABLE.path,
        }),
      );
      const posture = customRunnerSecurityPosture(row.role, row.contract);

      expect(posture).toEqual(row.posture);
      const scope = await resolveCustomRunnerAdmissionScope({
        projectDir,
        runner: configuredRunner,
        posture,
      });
      expect(scope).not.toBeNull();
      if (scope === null) throw new Error('Custom runner admission scope did not resolve');
      expect(scope.definitionId).toBe('disclosure-fixture');
      expect(scope.definitionDigest).toBe(row.definitionDigest);
      definitionDigests.push(scope.definitionDigest);
    }

    expect(new Set(definitionDigests)).toHaveLength(4);
  });

  it('scopes an inline runner receipt away from the identical configured command', async () => {
    const projectDir = createTempDir('custom-trust-inline-posture-project');
    directories.push(projectDir);
    const inlineDigests = [
      {
        role: 'planner',
        contract: 'output',
        definitionDigest: 'sha256:2425fadd08396cc5a28251d55e4cbb52c38a9b5481b2fb17b5eae8b44c42d686',
      },
      {
        role: 'planner',
        contract: 'direct',
        definitionDigest: 'sha256:71adff2db76071a930eef97c66bd665bb5a7c340b9222023a8d6ec2e4574f307',
      },
      {
        role: 'implementer',
        contract: 'output',
        definitionDigest: 'sha256:6f2758a47120876d46458312910f24bb02fea0681392fcc51128528a3b035683',
      },
      {
        role: 'implementer',
        contract: 'direct',
        definitionDigest: 'sha256:ff806ef6d53d4d0fb628416905debece9236725c95099f17891c18dff05c204a',
      },
    ] as const;

    for (const row of inlineDigests) {
      const declaration = command({
        id: 'disclosure-fixture',
        label: 'Disclosure fixture runner',
        contract: row.contract,
        executable: DISCLOSURE_EXECUTABLE.path,
      });
      const inlineScope = await resolveCustomRunnerAdmissionScope({
        projectDir,
        runner: { source: 'inline', command: declaration },
        posture: inlineRunnerSecurityPosture(row.role, row.contract),
      });
      const configuredScope = await resolveCustomRunnerAdmissionScope({
        projectDir,
        runner: { source: 'configured', command: declaration },
        posture: customRunnerSecurityPosture(row.role, row.contract),
      });

      expect(inlineScope?.definitionDigest).toBe(row.definitionDigest);
      expect(inlineScope?.definitionDigest).not.toBe(configuredScope?.definitionDigest);
    }
  });

  it('refuses an inline runner presented with the staged configured posture', async () => {
    const projectDir = createTempDir('custom-trust-inline-posture-mismatch');
    directories.push(projectDir);

    await expect(
      resolveCustomRunnerAdmissionScope({
        projectDir,
        runner: { source: 'inline', command: command() },
        posture: customRunnerSecurityPosture('planner', 'output'),
      }),
    ).resolves.toBeNull();
  });

  it('rejects old diff-only planner posture and cannot reuse its direct receipt', async () => {
    const projectDir = createTempDir('custom-trust-planner-direct-project');
    const stateDir = createTempDir('custom-trust-planner-direct-state');
    directories.push(projectDir, stateDir);
    const configuredRunner = runner(command({ id: 'planner-direct', contract: 'direct' }));
    const plannerPosture = customRunnerSecurityPosture('planner', 'direct');
    const diffOnlyPosture = customRunnerSecurityPosture('implementer', 'direct');
    const [plannerScope, diffOnlyScope] = await Promise.all([
      resolveCustomRunnerAdmissionScope({
        projectDir,
        runner: configuredRunner,
        posture: plannerPosture,
      }),
      resolveCustomRunnerAdmissionScope({
        projectDir,
        runner: configuredRunner,
        posture: diffOnlyPosture,
      }),
    ]);

    expect(plannerScope).not.toBeNull();
    expect(diffOnlyScope).not.toBeNull();
    if (plannerScope === null || diffOnlyScope === null) {
      throw new Error('Custom runner admission scope did not resolve');
    }
    expect(plannerScope.definitionDigest).not.toBe(diffOnlyScope.definitionDigest);

    await markCustomRunnerTrusted({
      projectDir,
      runner: configuredRunner,
      posture: diffOnlyPosture,
      executable: await executable(projectDir),
      stateDir,
    });
    await expect(
      readCustomRunnerTrust({
        projectDir,
        runner: configuredRunner,
        posture: plannerPosture,
        stateDir,
      }),
    ).resolves.toEqual({ kind: 'stale' });

    const invalidPostures: unknown[] = [
      { ...plannerPosture, result: 'reviewed-diff-only' },
      { ...plannerPosture, result: 'parsed-output-only' },
      {
        ...diffOnlyPosture,
        result: 'reviewed-declared-artifact-or-workspace-diff-only',
      },
    ];
    for (const posture of invalidPostures) {
      await expect(
        resolveCustomRunnerAdmissionScope({ projectDir, runner: configuredRunner, posture }),
      ).resolves.toBeNull();
      expect(
        buildCustomRunnerDisclosure({
          runner: configuredRunner,
          posture,
          executable: await executable(projectDir),
        }),
      ).toBeNull();
    }
  });
});
