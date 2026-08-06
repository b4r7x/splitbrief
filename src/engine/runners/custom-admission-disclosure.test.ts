import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { CONFIRM_PHRASE, type TieredApprovalRequest } from '../../core/approval/types.js';
import { normalizeCustomCommand } from '../../core/config/custom-commands.js';
import { taskId } from '../../core/schemas/task.js';
import { cleanupTempDir, createTempDir } from '#testing/helpers/temp-dir.js';
import {
  customRunnerSecurityPosture,
  resolveCustomRunnerTrustFile,
  type ConfiguredCustomRunner,
} from './custom-trust.js';
import {
  prepareCustomRunnerAdmission,
  type PrepareCustomRunnerAdmissionOptions,
} from './custom-admission.js';
import { resolveCustomExecutable } from './resolve-cli-executable.js';

const RECEIPT_CONFIRMATION_NOTICE = 'Exact confirmation stores an owner-only reusable receipt.';
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
  it('requires one exact interactive confirmation, persists a receipt, and returns the re-admitted token', async () => {
    const projectDir = createTempDir('custom-admission-interactive-project');
    const stateDir = createTempDir('custom-admission-interactive-state');
    directories.push(projectDir, stateDir);
    const configuredRunner = runner();
    const requests: TieredApprovalRequest[] = [];

    const admission = await prepareCustomRunnerAdmission(
      admissionOptions(projectDir, stateDir, configuredRunner, {
        allowRepoRunners: true,
        taskId: taskId('T001'),
        onTieredApproval: async (request) => {
          requests.push(request);
          return {
            decision: 'confirm',
            phrase: CONFIRM_PHRASE,
            reason: 'I reviewed this command.',
          };
        },
      }),
    );

    expect(requests).toEqual([
      {
        tier: 'confirm',
        actionClass: 'network',
        actionDescription: `Executable: ${JSON.stringify((await resolvedExecutable(projectDir)).path)}
Arguments: (none)
Contract: output
Working directory: Disposable staged project
Staging: Filtered disposable stage
Environment names: "ADMISSION_TEST_SECRET"
Environment access: Declared environment references only
Filesystem: Not an OS sandbox; the process can access files available to the current user
Network: Network access is not restricted
Result: Parsed output only; stage-local writes are discarded

${RECEIPT_CONFIRMATION_NOTICE}`,
        phase: 'planning',
        taskId: taskId('T001'),
      },
    ]);
    expect(admission).toMatchObject({
      kind: 'admitted',
      invocation: { authorization: 'receipt', runner: configuredRunner },
    });
    expect(existsSync(resolveCustomRunnerTrustFile(stateDir))).toBe(true);
  });

  it('keeps rejected and cancelled disclosures from persisting trust or executing a child', async () => {
    const cases = [
      {
        name: 'rejection',
        respond: async () => ({ decision: 'deny' as const, reason: 'No, cancel this run.' }),
      },
      {
        name: 'cancelled callback',
        respond: async () => {
          throw new Error('callback-cancelled-secret');
        },
      },
      {
        name: 'wrong phrase',
        respond: async () => ({
          decision: 'confirm' as const,
          phrase: 'I agree',
          reason: 'Reviewed.',
        }),
      },
      {
        name: 'blank reason',
        respond: async () => ({
          decision: 'confirm' as const,
          phrase: CONFIRM_PHRASE,
          reason: '   ',
        }),
      },
    ];

    for (const scenario of cases) {
      const projectDir = createTempDir(`custom-admission-${scenario.name}-project`);
      const stateDir = createTempDir(`custom-admission-${scenario.name}-state`);
      directories.push(projectDir, stateDir);
      const sentinel = join(projectDir, 'runner-executed');
      const admission = await prepareCustomRunnerAdmission(
        admissionOptions(projectDir, stateDir, runner(sentinel), {
          onTieredApproval: scenario.respond,
        }),
      );

      expect(admission).toMatchObject({ kind: 'denied' });
      expect(JSON.stringify(admission)).not.toContain('callback-cancelled-secret');
      expect(existsSync(resolveCustomRunnerTrustFile(stateDir))).toBe(false);
      expect(existsSync(sentinel)).toBe(false);
    }
  });

  it('fails closed when a confirmed receipt cannot be written', async () => {
    const projectDir = createTempDir('custom-admission-write-project');
    const parentDir = createTempDir('custom-admission-write-state-parent');
    directories.push(projectDir, parentDir);
    const invalidStateDir = join(parentDir, 'not-a-directory');
    writeFileSync(invalidStateDir, 'not a directory');
    const sentinel = join(projectDir, 'runner-executed');

    const admission = await prepareCustomRunnerAdmission(
      admissionOptions(projectDir, invalidStateDir, runner(sentinel), {
        onTieredApproval: async () => ({
          decision: 'confirm',
          phrase: CONFIRM_PHRASE,
          reason: 'I reviewed this command.',
        }),
      }),
    );

    expect(admission).toMatchObject({ kind: 'denied' });
    expect(existsSync(resolveCustomRunnerTrustFile(invalidStateDir))).toBe(false);
    expect(existsSync(sentinel)).toBe(false);
  });
});
