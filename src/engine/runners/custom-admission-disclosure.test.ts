import {
  chmodSync,
  existsSync,
  readFileSync,
  realpathSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { CONFIRM_PHRASE, type TieredApprovalRequest } from '../../core/approval/types.js';
import { normalizeCustomCommand } from '../../core/config/custom-commands.js';
import { taskId } from '../../core/schemas/task.js';
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
import { customRunnerRefusal } from './prepare-execution/evaluate-candidate.js';

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

/** A runner trusted on its first script, whose script is then replaced, as an upgrade does. */
async function changedRunner(name: string) {
  const projectDir = createTempDir(`custom-admission-${name}-project`);
  const stateDir = createTempDir(`custom-admission-${name}-state`);
  const binDir = createTempDir(`custom-admission-${name}-bin`);
  directories.push(projectDir, stateDir, binDir);
  const executablePath = join(binDir, 'changed-runner');
  writeFileSync(executablePath, '#!/bin/sh\necho original\n', { mode: 0o755 });
  chmodSync(executablePath, 0o755);
  const configuredRunner: ConfiguredCustomRunner = {
    source: 'configured',
    command: normalizeCustomCommand('changed-runner', {
      label: 'Changed runner',
      contract: 'output',
      executable: executablePath,
    }),
  };
  const original = await resolveCustomExecutable({ command: executablePath, projectDir });
  if (original.kind !== 'resolved') throw new Error('changed runner fixture did not resolve');
  await markCustomRunnerTrusted({
    projectDir: realpathSync(projectDir),
    stateDir,
    runner: configuredRunner,
    posture: customRunnerSecurityPosture('planner', 'output'),
    executable: original.executable,
  });
  writeFileSync(executablePath, '#!/bin/sh\necho upgraded\n', { mode: 0o755 });
  chmodSync(executablePath, 0o755);
  const trustFile = resolveCustomRunnerTrustFile(stateDir);
  return {
    projectDir,
    stateDir,
    configuredRunner,
    trustFile,
    executablePath,
    receiptBefore: readFileSync(trustFile, 'utf8'),
  };
}

afterEach(() => {
  for (const directory of directories) cleanupTempDir(directory);
  directories = [];
});

describe('prepareCustomRunnerAdmission', () => {
  it('admits on the exact phrase with no reason, persists a receipt, and returns the re-admitted token', async () => {
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
          return { decision: 'confirm', phrase: CONFIRM_PHRASE, reason: '' };
        },
      }),
    );

    expect(requests).toEqual([
      expect.objectContaining({
        tier: 'confirm',
        actionClass: 'runner_trust',
        phase: 'planning',
        taskId: taskId('T001'),
      }),
    ]);
    expect(requests[0]?.actionDescription).toContain('"ADMISSION_TEST_SECRET"');
    expect(requests[0]?.actionDescription).toContain(RECEIPT_CONFIRMATION_NOTICE);
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

  it('asks again for a changed executable and replaces the receipt on confirmation', async () => {
    const fixture = await changedRunner('changed-confirm');
    const requests: TieredApprovalRequest[] = [];

    const admission = await prepareCustomRunnerAdmission(
      admissionOptions(fixture.projectDir, fixture.stateDir, fixture.configuredRunner, {
        onTieredApproval: async (request) => {
          requests.push(request);
          return { decision: 'confirm', phrase: CONFIRM_PHRASE, reason: '' };
        },
      }),
    );

    expect(requests).toHaveLength(1);
    expect(requests[0]?.actionDescription.split('\n\n')[0]).toBe(
      'The executable changed since this machine trusted it.',
    );
    expect(admission).toMatchObject({
      kind: 'admitted',
      trustPersisted: true,
      invocation: { authorization: 'receipt' },
    });
    expect(readFileSync(fixture.trustFile, 'utf8')).not.toBe(fixture.receiptBefore);

    const next = await prepareCustomRunnerAdmission(
      admissionOptions(fixture.projectDir, fixture.stateDir, fixture.configuredRunner, {
        interaction: 'headless',
      }),
    );
    expect(next).toMatchObject({ kind: 'admitted', invocation: { authorization: 'receipt' } });
  });

  it('refuses a changed executable it may not ask about, naming the change and a fix that admits it', async () => {
    const fixture = await changedRunner('changed-headless');

    const refused = await prepareCustomRunnerAdmission(
      admissionOptions(fixture.projectDir, fixture.stateDir, fixture.configuredRunner, {
        interaction: 'headless',
      }),
    );
    const declined = await prepareCustomRunnerAdmission(
      admissionOptions(fixture.projectDir, fixture.stateDir, fixture.configuredRunner, {
        onTieredApproval: async () => ({ decision: 'deny', reason: 'Not now.' }),
      }),
    );

    expect(refused).toEqual({ kind: 'denied', status: 'drifted' });
    expect(declined).toEqual({ kind: 'denied', status: 'drifted' });
    expect(customRunnerRefusal(refused, 'shell')).toEqual({
      reason: 'The shell runner executable changed since this machine trusted it.',
      fix: 'Run SPLITBRIEF in a terminal and confirm the changed executable, or pass --allow-repo-runners to grant it for this run only.',
    });
    expect(readFileSync(fixture.trustFile, 'utf8')).toBe(fixture.receiptBefore);

    const granted = await prepareCustomRunnerAdmission(
      admissionOptions(fixture.projectDir, fixture.stateDir, fixture.configuredRunner, {
        interaction: 'headless',
        allowRepoRunners: true,
      }),
    );
    expect(granted).toMatchObject({
      kind: 'admitted',
      trustPersisted: false,
      invocation: { authorization: 'explicit-grant' },
    });
    expect(readFileSync(fixture.trustFile, 'utf8')).toBe(fixture.receiptBefore);
  });

  it('denies a changed executable that changes again while its prompt is open', async () => {
    const fixture = await changedRunner('changed-swap');

    const admission = await prepareCustomRunnerAdmission(
      admissionOptions(fixture.projectDir, fixture.stateDir, fixture.configuredRunner, {
        onTieredApproval: async () => {
          writeFileSync(fixture.executablePath, '#!/bin/sh\necho swapped\n', { mode: 0o755 });
          chmodSync(fixture.executablePath, 0o755);
          return { decision: 'confirm', phrase: CONFIRM_PHRASE, reason: '' };
        },
      }),
    );

    expect(admission).toEqual({ kind: 'denied', status: 'drifted' });
    expect(readFileSync(fixture.trustFile, 'utf8')).toBe(fixture.receiptBefore);
  });

  it('denies a changed executable that is removed while its prompt is open', async () => {
    const fixture = await changedRunner('changed-removed');

    const admission = await prepareCustomRunnerAdmission(
      admissionOptions(fixture.projectDir, fixture.stateDir, fixture.configuredRunner, {
        onTieredApproval: async () => {
          unlinkSync(fixture.executablePath);
          return { decision: 'confirm', phrase: CONFIRM_PHRASE, reason: '' };
        },
      }),
    );

    expect(admission).toEqual({ kind: 'denied', status: 'missing' });
    expect(readFileSync(fixture.trustFile, 'utf8')).toBe(fixture.receiptBefore);
  });
});
