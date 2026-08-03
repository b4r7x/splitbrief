import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { CONFIRM_PHRASE, type TieredApprovalRequest } from '../../core/approval/types.js';
import { normalizeCustomCommand } from '../../core/config/custom-commands.js';
import { cleanupTempDir, createTempDir } from '#testing/helpers/temp-dir.js';
import {
  customRunnerSecurityPosture,
  markCustomRunnerTrusted,
  resolveCustomRunnerTrustFile,
  type ConfiguredCustomRunner,
} from './custom-trust.js';
import {
  prepareCustomRunnerAdmission,
  type PrepareCustomRunnerAdmissionOptions,
} from './custom-admission.js';
import { resolveCustomExecutable } from './resolve-cli-executable.js';

const itUnix = process.platform === 'win32' ? it.skip : it;
let directories: string[] = [];

function runner(sentinel?: string): ConfiguredCustomRunner {
  return {
    source: 'configured',
    command: normalizeCustomCommand('admission-test-runner', {
      label: 'Admission test runner',
      contract: 'output',
      executable: process.execPath,
      ...(sentinel === undefined
        ? {}
        : {
            argv: [
              '-e',
              `require('node:fs').writeFileSync(${JSON.stringify(sentinel)}, 'executed')`,
            ],
          }),
      env: ['ADMISSION_TEST_SECRET'],
    }),
  };
}

function admissionOptions(
  projectDir: string,
  stateDir: string,
  configuredRunner: ConfiguredCustomRunner,
  overrides: Partial<PrepareCustomRunnerAdmissionOptions> = {},
): PrepareCustomRunnerAdmissionOptions {
  return {
    projectDir,
    stateDir,
    runner: configuredRunner,
    posture: customRunnerSecurityPosture('planner', 'output'),
    interaction: 'interactive',
    allowRepoRunners: false,
    phase: 'planning',
    authorizationPathEnv: process.env.PATH,
    authorizationPathExt: process.env.PATHEXT,
    ...overrides,
  };
}

async function resolvedExecutable(projectDir: string, pathEnv?: string) {
  const resolution = await resolveCustomExecutable({
    command: process.execPath,
    projectDir,
    ...(pathEnv === undefined ? {} : { pathEnv }),
  });
  if (resolution.kind !== 'resolved')
    throw new Error('Custom runner test executable did not resolve');
  return resolution.executable;
}

afterEach(() => {
  for (const directory of directories) cleanupTempDir(directory);
  directories = [];
});

describe('prepareCustomRunnerAdmission', () => {
  it('reuses a matching owner-only receipt without a prompt or a new persistence side effect', async () => {
    const projectDir = createTempDir('custom-admission-receipt-project');
    const stateDir = createTempDir('custom-admission-receipt-state');
    directories.push(projectDir, stateDir);
    const sentinel = join(projectDir, 'runner-executed');
    const configuredRunner = runner(sentinel);
    const posture = customRunnerSecurityPosture('planner', 'output');
    await markCustomRunnerTrusted({
      projectDir,
      stateDir,
      runner: configuredRunner,
      posture,
      executable: await resolvedExecutable(projectDir),
    });
    const trustPath = resolveCustomRunnerTrustFile(stateDir);
    const receiptBefore = readFileSync(trustPath, 'utf8');
    const requests: TieredApprovalRequest[] = [];

    const admission = await prepareCustomRunnerAdmission(
      admissionOptions(projectDir, stateDir, configuredRunner, {
        allowRepoRunners: true,
        onTieredApproval: async (request) => {
          requests.push(request);
          return { decision: 'deny', reason: 'must not be asked' };
        },
      }),
    );

    expect(admission).toMatchObject({
      kind: 'admitted',
      invocation: { authorization: 'receipt', runner: configuredRunner },
    });
    expect(requests).toEqual([]);
    expect(readFileSync(trustPath, 'utf8')).toBe(receiptBefore);
    expect(existsSync(sentinel)).toBe(false);
  });

  it('uses only receipt or the explicit headless grant and never prompts or writes for that grant', async () => {
    const projectDir = createTempDir('custom-admission-headless-project');
    const stateDir = createTempDir('custom-admission-headless-state');
    directories.push(projectDir, stateDir);
    const sentinel = join(projectDir, 'runner-executed');
    const configuredRunner = runner(sentinel);
    const requests: TieredApprovalRequest[] = [];
    const withoutGrant = admissionOptions(projectDir, stateDir, configuredRunner, {
      interaction: 'headless',
      allowRepoRunners: false,
      onTieredApproval: async (request) => {
        requests.push(request);
        return { decision: 'confirm', phrase: CONFIRM_PHRASE, reason: 'must not be asked' };
      },
    });

    await expect(prepareCustomRunnerAdmission(withoutGrant)).resolves.toMatchObject({
      kind: 'denied',
    });
    expect(existsSync(resolveCustomRunnerTrustFile(stateDir))).toBe(false);

    const withGrant = await prepareCustomRunnerAdmission({
      ...withoutGrant,
      allowRepoRunners: true,
    });
    expect(withGrant).toMatchObject({
      kind: 'admitted',
      invocation: { authorization: 'explicit-grant', runner: configuredRunner },
    });
    expect(requests).toEqual([]);
    expect(existsSync(resolveCustomRunnerTrustFile(stateDir))).toBe(false);
    expect(existsSync(sentinel)).toBe(false);

    await markCustomRunnerTrusted({
      projectDir,
      stateDir,
      runner: configuredRunner,
      posture: customRunnerSecurityPosture('planner', 'output'),
      executable: await resolvedExecutable(projectDir),
    });
    const receipt = await prepareCustomRunnerAdmission(withoutGrant);
    expect(receipt).toMatchObject({
      kind: 'admitted',
      invocation: { authorization: 'receipt', runner: configuredRunner },
    });
    expect(requests).toEqual([]);
  });

  itUnix(
    'does not authorize an executable replaced while its interactive disclosure is awaiting confirmation',
    async () => {
      const projectDir = createTempDir('custom-admission-prompt-swap-project');
      const stateDir = createTempDir('custom-admission-prompt-swap-state');
      const binDir = createTempDir('custom-admission-prompt-swap-bin');
      directories.push(projectDir, stateDir, binDir);
      const executableName = 'custom-admission-prompt-swap';
      const executablePath = join(binDir, executableName);
      const originalStarted = join(projectDir, 'original-started');
      const replacementStarted = join(projectDir, 'replacement-started');
      writeFileSync(
        executablePath,
        `#!/bin/sh\nprintf original > ${JSON.stringify(originalStarted)}\n`,
        { mode: 0o755 },
      );
      chmodSync(executablePath, 0o755);
      const configuredRunner: ConfiguredCustomRunner = {
        source: 'configured',
        command: normalizeCustomCommand('prompt-swap-runner', {
          label: 'Prompt swap runner',
          contract: 'output',
          executable: executableName,
        }),
      };

      const admission = await prepareCustomRunnerAdmission(
        admissionOptions(projectDir, stateDir, configuredRunner, {
          authorizationPathEnv: binDir,
          onTieredApproval: async () => {
            writeFileSync(
              executablePath,
              `#!/bin/sh\nprintf replacement > ${JSON.stringify(replacementStarted)}\n`,
              { mode: 0o755 },
            );
            chmodSync(executablePath, 0o755);
            return {
              decision: 'confirm',
              phrase: CONFIRM_PHRASE,
              reason: 'I reviewed the disclosed executable.',
            };
          },
        }),
      );

      expect(admission).toEqual({ kind: 'denied', status: 'drifted' });
      expect(existsSync(resolveCustomRunnerTrustFile(stateDir))).toBe(false);
      expect(existsSync(originalStarted)).toBe(false);
      expect(existsSync(replacementStarted)).toBe(false);
    },
  );

  itUnix(
    're-admits against the authorization PATH captured before confirmation, not a later path or ambient mutation',
    async () => {
      const projectDir = createTempDir('custom-admission-captured-path-project');
      const stateDir = createTempDir('custom-admission-captured-path-state');
      const admittedBin = createTempDir('custom-admission-captured-path-admitted');
      const replacementBin = createTempDir('custom-admission-captured-path-replacement');
      directories.push(projectDir, stateDir, admittedBin, replacementBin);
      const executableName = 'custom-admission-captured-path';
      const admittedExecutable = join(admittedBin, executableName);
      const replacementExecutable = join(replacementBin, executableName);
      writeFileSync(admittedExecutable, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
      writeFileSync(replacementExecutable, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
      chmodSync(admittedExecutable, 0o755);
      chmodSync(replacementExecutable, 0o755);
      const configuredRunner: ConfiguredCustomRunner = {
        source: 'configured',
        command: normalizeCustomCommand('captured-path-runner', {
          label: 'Captured PATH runner',
          contract: 'output',
          executable: executableName,
        }),
      };
      let currentAuthorizationPath = admittedBin;
      const originalPath = process.env.PATH;
      const options: PrepareCustomRunnerAdmissionOptions = {
        projectDir,
        stateDir,
        runner: configuredRunner,
        posture: customRunnerSecurityPosture('planner', 'output'),
        interaction: 'interactive',
        allowRepoRunners: false,
        phase: 'planning',
        get authorizationPathEnv() {
          return currentAuthorizationPath;
        },
        onTieredApproval: async () => {
          currentAuthorizationPath = replacementBin;
          process.env.PATH = replacementBin;
          return {
            decision: 'confirm',
            phrase: CONFIRM_PHRASE,
            reason: 'I reviewed the disclosed executable.',
          };
        },
      };

      try {
        const admission = await prepareCustomRunnerAdmission(options);
        expect(admission).toMatchObject({
          kind: 'admitted',
          invocation: {
            authorization: 'receipt',
            executable: { path: realpathSync(admittedExecutable) },
          },
        });
      } finally {
        if (originalPath === undefined) delete process.env.PATH;
        else process.env.PATH = originalPath;
      }
    },
  );

  it('rejects callback-time runner and posture mutation without writing a receipt', async () => {
    const projectDir = createTempDir('custom-admission-snapshot-project');
    const stateDir = createTempDir('custom-admission-snapshot-state');
    directories.push(projectDir, stateDir);
    const mutableRunner = {
      source: 'configured' as const,
      command: {
        ...normalizeCustomCommand('snapshot-runner', {
          label: 'Snapshot runner',
          contract: 'output',
          executable: process.execPath,
          argv: ['--version'],
        }),
        argv: ['--version'],
        env: [] as string[],
      },
    };
    const mutablePosture = { ...customRunnerSecurityPosture('planner', 'output') };
    const admission = await prepareCustomRunnerAdmission({
      projectDir,
      stateDir,
      runner: mutableRunner,
      posture: mutablePosture,
      interaction: 'interactive',
      allowRepoRunners: false,
      phase: 'planning',
      onTieredApproval: async () => {
        mutableRunner.command.contract = 'direct';
        mutableRunner.command.argv = ['--eval', 'process.exitCode = 1'];
        mutableRunner.command.env = ['MUTATED_ENV'];
        mutablePosture.role = 'implementer';
        mutablePosture.result = 'reviewed-diff-only';
        return {
          decision: 'confirm',
          phrase: CONFIRM_PHRASE,
          reason: 'I reviewed the original disclosure.',
        };
      },
    });

    expect(admission).toEqual({ kind: 'denied', status: 'invalid' });
    expect(existsSync(resolveCustomRunnerTrustFile(stateDir))).toBe(false);
  });

  itUnix(
    'rejects a project symlink retargeted while confirmation is pending without writing a receipt',
    async () => {
      const rootDir = createTempDir('custom-admission-project-retarget-root');
      const stateDir = createTempDir('custom-admission-project-retarget-state');
      directories.push(rootDir, stateDir);
      const originalProject = join(rootDir, 'original-project');
      const replacementProject = join(rootDir, 'replacement-project');
      const projectLink = join(rootDir, 'project-link');
      mkdirSync(originalProject);
      mkdirSync(replacementProject);
      symlinkSync(originalProject, projectLink);

      const admission = await prepareCustomRunnerAdmission(
        admissionOptions(projectLink, stateDir, runner(), {
          onTieredApproval: async () => {
            unlinkSync(projectLink);
            symlinkSync(replacementProject, projectLink);
            return {
              decision: 'confirm',
              phrase: CONFIRM_PHRASE,
              reason: 'I reviewed the original project.',
            };
          },
        }),
      );

      expect(admission).toEqual({ kind: 'denied', status: 'invalid' });
      expect(existsSync(resolveCustomRunnerTrustFile(stateDir))).toBe(false);
    },
  );

  itUnix(
    'keeps an absent authorization PATH empty even if reading that absence changes ambient PATH',
    async () => {
      const projectDir = createTempDir('custom-admission-absent-path-project');
      const stateDir = createTempDir('custom-admission-absent-path-state');
      const ambientBin = createTempDir('custom-admission-absent-path-bin');
      directories.push(projectDir, stateDir, ambientBin);
      const executableName = 'custom-admission-ambient-only';
      const executablePath = join(ambientBin, executableName);
      writeFileSync(executablePath, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
      chmodSync(executablePath, 0o755);
      const configuredRunner: ConfiguredCustomRunner = {
        source: 'configured',
        command: normalizeCustomCommand('ambient-path-runner', {
          label: 'Ambient PATH runner',
          contract: 'output',
          executable: executableName,
        }),
      };
      const originalPath = process.env.PATH;
      const options: PrepareCustomRunnerAdmissionOptions = {
        projectDir,
        stateDir,
        runner: configuredRunner,
        posture: customRunnerSecurityPosture('planner', 'output'),
        interaction: 'headless',
        allowRepoRunners: true,
        phase: 'planning',
        get authorizationPathEnv() {
          process.env.PATH = ambientBin;
          return undefined;
        },
      };

      try {
        await expect(prepareCustomRunnerAdmission(options)).resolves.toEqual({
          kind: 'denied',
          status: 'missing',
        });
      } finally {
        if (originalPath === undefined) delete process.env.PATH;
        else process.env.PATH = originalPath;
      }
      expect(existsSync(resolveCustomRunnerTrustFile(stateDir))).toBe(false);
    },
  );

  itUnix(
    'uses the separately supplied authorization PATH without reading a source environment',
    async () => {
      const projectDir = createTempDir('custom-admission-path-project');
      const stateDir = createTempDir('custom-admission-path-state');
      const binDir = createTempDir('custom-admission-path-bin');
      directories.push(projectDir, stateDir, binDir);
      const executableName = 'custom-admission-authority-only';
      const executablePath = join(binDir, executableName);
      writeFileSync(executablePath, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
      chmodSync(executablePath, 0o755);
      const configuredRunner: ConfiguredCustomRunner = {
        source: 'configured',
        command: normalizeCustomCommand('authorization-path-runner', {
          label: 'Authorization PATH runner',
          contract: 'output',
          executable: executableName,
        }),
      };

      const admission = await prepareCustomRunnerAdmission(
        admissionOptions(projectDir, stateDir, configuredRunner, {
          interaction: 'headless',
          allowRepoRunners: true,
          authorizationPathEnv: binDir,
        }),
      );

      expect(admission).toMatchObject({
        kind: 'admitted',
        invocation: { authorization: 'explicit-grant', runner: configuredRunner },
      });
      expect(existsSync(resolveCustomRunnerTrustFile(stateDir))).toBe(false);
    },
  );
});
