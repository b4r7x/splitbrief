import { chmodSync, existsSync, mkdirSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { normalizeCustomCommand } from '../../core/config/custom-commands.js';
import { matches } from '../../utils/error.js';
import { createStagedProject } from '../orchestrator/approval/staged-project.js';
import {
  customRunnerSecurityPosture,
  type ConfiguredCustomRunner,
} from '../runners/custom-trust.js';
import { prepareCustomRunnerAdmission } from '../runners/custom-admission.js';
import { customRunnerAdmissionError } from '../runners/custom-launchability.js';
import type { CustomRunnerRuntimePort } from '../runners/types.js';
import { createConfiguredCustomPlanner as createPreparedConfiguredCustomPlanner } from './command-invoke.js';
import {
  configuredPlanner,
  createCommandInvokeTestFixtures,
  itUnix,
  reviewCandidateRoot,
  runtimeFor,
  shellLiteral,
} from '#testing/helpers/planner-command-invoke.js';
import { createTempDir } from '#testing/helpers/temp-dir.js';

const { testProject, trackDirectories } = createCommandInvokeTestFixtures();

async function createConfiguredCustomPlanner(
  runner: ConfiguredCustomRunner,
  runtime: CustomRunnerRuntimePort,
) {
  const admission = await prepareCustomRunnerAdmission({
    ...runtime.admission,
    projectDir: runtime.authorizationProjectDir,
    runner,
    posture: customRunnerSecurityPosture('planner', runner.command.contract),
    phase: 'planning',
    authorizationPathEnv: runtime.authorizationPathEnv ?? '',
    authorizationPathExt: runtime.authorizationPathExt ?? '',
  });
  if (admission.kind !== 'admitted') throw customRunnerAdmissionError.denied('planner');
  return createPreparedConfiguredCustomPlanner(runner, runtime, admission.invocation);
}

describe('createConfiguredCustomPlanner admission and output behavior', () => {
  it('runs output planners in a fresh child stage and discards their writes', async () => {
    const { projectDir, stateDir } = testProject('configured-output');
    const staleReviewRoot = reviewCandidateRoot(projectDir);
    const stalePath = join(staleReviewRoot, 'stale-call', 'result');
    mkdirSync(join(staleReviewRoot, 'stale-call'), { recursive: true });
    writeFileSync(stalePath, 'stale');
    let childStagePath = '';
    const planner = await createConfiguredCustomPlanner(
      configuredPlanner({
        contract: 'output',
        script: [
          "require('node:fs').writeFileSync('discarded-by-output.txt', 'discard me');",
          "process.stdout.write('parsed output only');",
        ].join(''),
      }),
      runtimeFor({
        projectDir,
        stateDir,
        createStage: async (sourceProjectDir) => {
          const stage = await createStagedProject(sourceProjectDir);
          childStagePath = stage.projectDir;
          return stage;
        },
        beginDeclaredArtifactReview: async () => {
          throw new Error('Output planner must not begin declared artifact review.');
        },
      }),
    );

    await expect(planner.review('review this', projectDir, { onOutput: vi.fn() })).resolves.toEqual(
      expect.objectContaining({ text: expect.stringContaining('parsed output only') }),
    );

    expect(existsSync(join(projectDir, 'discarded-by-output.txt'))).toBe(false);
    expect(existsSync(childStagePath)).toBe(false);
    expect(existsSync(stalePath)).toBe(false);
    expect(existsSync(staleReviewRoot)).toBe(false);
  });

  itUnix(
    'uses output sourceEnv values while executable authority ignores sourceEnv.PATH',
    async () => {
      const { projectDir, stateDir } = testProject('configured-output-source-env');
      const authorizedBin = createTempDir('configured-output-authorized-bin');
      const sourceOnlyBin = createTempDir('configured-output-source-only-bin');
      trackDirectories(authorizedBin, sourceOnlyBin);
      const executable = 'configured-output-authority';
      const competingSentinel = join(projectDir, 'source-path-child-started');
      const writeRunner = (directory: string, body: string) => {
        const path = join(directory, executable);
        writeFileSync(path, `#!/bin/sh\n${body}\n`);
        chmodSync(path, 0o755);
      };
      writeRunner(
        authorizedBin,
        "if [ \"$PLANNER_OUTPUT_CANARY\" != 'only-from-source' ]; then exit 17; fi\nprintf 'authorized output source env'",
      );
      writeRunner(sourceOnlyBin, `printf started > ${shellLiteral(competingSentinel)}`);
      const runner: ConfiguredCustomRunner = {
        source: 'configured',
        command: normalizeCustomCommand('configured-output-authority', {
          label: 'Configured output authority',
          contract: 'output',
          executable,
          env: ['PLANNER_OUTPUT_CANARY'],
        }),
      };
      const planner = await createConfiguredCustomPlanner(
        runner,
        runtimeFor({
          projectDir,
          stateDir,
          sourceEnv: {
            PATH: sourceOnlyBin,
            PLANNER_OUTPUT_CANARY: 'only-from-source',
          },
          authorizationPathEnv: authorizedBin,
        }),
      );

      await expect(
        planner.review('review this', projectDir, { onOutput: vi.fn() }),
      ).resolves.toEqual(
        expect.objectContaining({ text: expect.stringContaining('authorized output source env') }),
      );

      expect(existsSync(competingSentinel)).toBe(false);
    },
  );

  itUnix('does not use sourceEnv.PATH when authorization PATH is explicitly absent', async () => {
    const { projectDir, stateDir } = testProject('configured-absent-authorization-path');
    const sourceOnlyBin = createTempDir('configured-absent-authorization-bin');
    trackDirectories(sourceOnlyBin);
    const executable = 'configured-source-path-only';
    const childSentinel = join(projectDir, 'source-path-child-started');
    const executablePath = join(sourceOnlyBin, executable);
    writeFileSync(
      executablePath,
      `#!/bin/sh\nprintf started > ${shellLiteral(childSentinel)}\nprintf should-not-run\n`,
    );
    chmodSync(executablePath, 0o755);
    const runner: ConfiguredCustomRunner = {
      source: 'configured',
      command: normalizeCustomCommand('configured-source-path-only', {
        label: 'Configured source PATH only',
        contract: 'output',
        executable,
      }),
    };
    const runtime: CustomRunnerRuntimePort = {
      sessionId: 'planner-adapter-session',
      authorizationProjectDir: projectDir,
      sourceEnv: { PATH: sourceOnlyBin },
      authorizationPathEnv: undefined,
      authorizationPathExt: undefined,
      createStage: async (sourceProjectDir) => createStagedProject(sourceProjectDir),
      admission: {
        interaction: 'headless',
        allowRepoRunners: true,
        stateDir,
      },
      cleanupStaleArtifactReviews: async () => {},
      beginDeclaredArtifactReview: async () => {
        throw new Error('Output planner must not begin declared artifact review.');
      },
    };
    let denial: unknown;
    try {
      await createConfiguredCustomPlanner(runner, runtime);
    } catch (err) {
      denial = err;
    }

    expect(matches('custom-runner-admission-denied')(denial)).toBe(true);
    expect(denial).toMatchObject({
      kind: 'custom-runner-admission-denied',
      message: 'Configured custom planner admission was denied.',
    });
    expect(denial).toMatchObject({ data: undefined });

    expect(existsSync(childSentinel)).toBe(false);
  });

  it('rejects admission before creating a child stage or starting a child', async () => {
    const { projectDir, stateDir } = testProject('configured-admission-denied');
    const childSentinel = join(projectDir, 'child-started');
    await expect(
      createConfiguredCustomPlanner(
        configuredPlanner({
          contract: 'output',
          script: `require('node:fs').writeFileSync(${JSON.stringify(childSentinel)}, 'started');`,
        }),
        runtimeFor({
          projectDir,
          stateDir,
          allowRepoRunners: false,
          createStage: async () => {
            throw new Error('stage must not be created after denied admission');
          },
        }),
      ),
    ).rejects.toMatchObject({ kind: 'custom-runner-admission-denied' });

    expect(existsSync(childSentinel)).toBe(false);
  });

  itUnix(
    'stops when an authorization PATH link drifts before either candidate child starts',
    async () => {
      const { projectDir, stateDir } = testProject('configured-authorization-drift');
      const admittedBin = createTempDir('configured-admitted-bin');
      const competingBin = createTempDir('configured-competing-bin');
      const authorizationPathDir = createTempDir('configured-authorization-link');
      trackDirectories(admittedBin, competingBin, authorizationPathDir);
      const executable = 'configured-planner-authority';
      const admittedSentinel = join(projectDir, 'admitted-child-started');
      const competingSentinel = join(projectDir, 'competing-child-started');
      const writeRunner = (directory: string, sentinel: string) => {
        const path = join(directory, executable);
        writeFileSync(
          path,
          `#!/bin/sh\nprintf started > ${shellLiteral(sentinel)}\nprintf diagnostic\n`,
        );
        chmodSync(path, 0o755);
      };
      writeRunner(admittedBin, admittedSentinel);
      writeRunner(competingBin, competingSentinel);
      const authorizationPathLink = join(authorizationPathDir, 'authorization-bin');
      symlinkSync(admittedBin, authorizationPathLink);

      const runner: ConfiguredCustomRunner = {
        source: 'configured',
        command: normalizeCustomCommand('configured-planner-authority', {
          label: 'Configured planner authority',
          contract: 'output',
          executable,
        }),
      };
      const runtime: CustomRunnerRuntimePort = {
        sessionId: 'planner-adapter-session',
        authorizationProjectDir: projectDir,
        sourceEnv: {},
        authorizationPathEnv: authorizationPathLink,
        createStage: async (sourceProjectDir) => {
          unlinkSync(authorizationPathLink);
          symlinkSync(competingBin, authorizationPathLink);
          return createStagedProject(sourceProjectDir);
        },
        admission: {
          interaction: 'headless',
          allowRepoRunners: true,
          stateDir,
        },
        cleanupStaleArtifactReviews: async () => {},
        beginDeclaredArtifactReview: async () => {
          throw new Error('Output planner must not begin declared artifact review.');
        },
      };
      const planner = await createConfiguredCustomPlanner(runner, runtime);

      await expect(
        planner.review('review this', projectDir, { onOutput: vi.fn() }),
      ).rejects.toMatchObject({ kind: 'custom-runner-executable-drifted' });

      expect(existsSync(admittedSentinel)).toBe(false);
      expect(existsSync(competingSentinel)).toBe(false);
    },
  );
});
