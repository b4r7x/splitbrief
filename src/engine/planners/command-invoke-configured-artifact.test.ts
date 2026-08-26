import { existsSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { beginDeclaredArtifactReview } from '../orchestrator/approval/planner-artifact.js';
import { createStagedProject } from '../orchestrator/approval/staged-project.js';
import { createConfiguredCustomPlanner as createAdmittedConfiguredCustomPlanner } from './command-invoke.js';
import { prepareCustomRunnerAdmission } from '../runners/custom-admission.js';
import { customRunnerSecurityPosture } from '../runners/custom-trust.js';
import type { ConfiguredCustomRunner } from '../runners/custom-trust.js';
import type { RunnerGate } from '../runners/prepared-execution.js';
import type { CustomRunnerRuntimePort } from '../runners/types.js';
import { customRunnerAdmissionError } from '../runners/custom-launchability.js';
import {
  configuredPlanner,
  createCommandInvokeTestFixtures,
  itUnix,
  reviewCandidateRoot,
  runtimeFor,
} from '#testing/helpers/planner-command-invoke.js';
import { makeTask } from '#testing/helpers/factories/task.js';

const { testProject } = createCommandInvokeTestFixtures();

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
  const gate = {
    kind: runner.command.contract === 'output' ? 'shell' : 'agent',
    slot: { role: 'planner' },
    preparationId: 'configured-artifact-test',
    command: { kind: 'configured-custom', invocation: admission.invocation },
  } satisfies RunnerGate;
  return createAdmittedConfiguredCustomPlanner(runner, runtime, gate.command.invocation);
}

describe('createConfiguredCustomPlanner direct artifact behavior', () => {
  it('returns only an approved declared artifact for normal direct planner calls', async () => {
    const { projectDir, stateDir } = testProject('configured-direct-approve');
    const output: string[] = [];
    const planner = await createConfiguredCustomPlanner(
      configuredPlanner({
        contract: 'direct',
        script: [
          "require('node:fs').writeFileSync(process.env.SPLITBRIEF_DECLARED_ARTIFACT_PATH, 'reviewed artifact');",
          "process.stdout.write('diagnostic stdout');",
        ].join(''),
      }),
      runtimeFor({ projectDir, stateDir }),
    );

    await expect(
      planner.review('review this', projectDir, { onOutput: (text) => output.push(text) }),
    ).resolves.toEqual(expect.objectContaining({ text: 'reviewed artifact' }));

    expect(output.join('')).toContain('diagnostic stdout');
    expect(existsSync(join(projectDir, '.splitbrief-runner'))).toBe(false);
    expect(existsSync(reviewCandidateRoot(projectDir))).toBe(false);
  });

  it('orders the direct artifact lease around child execution and stage cleanup', async () => {
    const { projectDir, stateDir } = testProject('configured-direct-lease-order');
    const operations: string[] = [];
    const planner = await createConfiguredCustomPlanner(
      configuredPlanner({
        contract: 'direct',
        script:
          "require('node:fs').writeFileSync(process.env.SPLITBRIEF_DECLARED_ARTIFACT_PATH, 'leased artifact');",
      }),
      runtimeFor({
        projectDir,
        stateDir,
        createStage: async (sourceProjectDir) => {
          const stage = await createStagedProject(sourceProjectDir);
          return {
            ...stage,
            cleanup: () => {
              operations.push('stage-cleanup');
              stage.cleanup();
            },
          };
        },
        cleanupStaleArtifactReviews: async () => {
          operations.push('cleanup');
        },
        beginDeclaredArtifactReview: async (artifactInput) => {
          operations.push('begin');
          const prepared = await beginDeclaredArtifactReview({
            ...artifactInput,
            projectDir,
            sessionId: 'planner-adapter-session',
            onApprovalNeeded: async () => ({ approved: true }),
          });
          return {
            reviewAfterChild: async () => {
              operations.push('review');
              return prepared.reviewAfterChild();
            },
            readWithReceiptAfterChild: (readInput) => prepared.readWithReceiptAfterChild(readInput),
            getReceipt: () => prepared.getReceipt(),
            dispose: async () => {
              operations.push('dispose');
              await prepared.dispose();
            },
          };
        },
      }),
    );

    await expect(planner.review('review this', projectDir, { onOutput: vi.fn() })).resolves.toEqual(
      expect.objectContaining({ text: 'leased artifact' }),
    );

    expect(operations).toEqual([
      'cleanup',
      'begin',
      'review',
      'dispose',
      'stage-cleanup',
      'cleanup',
    ]);
  });

  it('does not promote a rejected normal direct planner artifact', async () => {
    const { projectDir, stateDir } = testProject('configured-direct-reject');
    const planner = await createConfiguredCustomPlanner(
      configuredPlanner({
        contract: 'direct',
        script:
          "require('node:fs').writeFileSync(process.env.SPLITBRIEF_DECLARED_ARTIFACT_PATH, 'must not promote');",
      }),
      runtimeFor({
        projectDir,
        stateDir,
        onApprovalNeeded: async () => ({ approved: false }),
      }),
    );

    await expect(
      planner.review('review this', projectDir, { onOutput: vi.fn() }),
    ).rejects.toMatchObject({ kind: 'custom-planner-artifact-rejected' });

    expect(existsSync(join(projectDir, '.splitbrief-runner'))).toBe(false);
    expect(existsSync(reviewCandidateRoot(projectDir))).toBe(false);
  });

  it('delivers direct planner artifact text as an immutable review without a candidate path', async () => {
    const { projectDir, stateDir } = testProject('configured-direct-candidate-race');
    let seenReview: unknown;
    let seenFrozen = false;
    let approvalRequests = 0;
    const planner = await createConfiguredCustomPlanner(
      configuredPlanner({
        contract: 'direct',
        script:
          "require('node:fs').writeFileSync(process.env.SPLITBRIEF_DECLARED_ARTIFACT_PATH, 'original artifact');",
      }),
      runtimeFor({
        projectDir,
        stateDir,
        onApprovalNeeded: async (_type, review) => {
          approvalRequests += 1;
          seenReview = review;
          seenFrozen = Object.isFrozen(review);
          return { approved: true };
        },
      }),
    );

    await expect(planner.review('review this', projectDir, { onOutput: vi.fn() })).resolves.toEqual(
      expect.objectContaining({ text: 'original artifact' }),
    );

    expect(approvalRequests).toBe(1);
    expect(seenReview).toEqual({ label: 'Custom planner artifact', text: 'original artifact' });
    expect(seenFrozen).toBe(true);
    expect(existsSync(reviewCandidateRoot(projectDir))).toBe(false);
  });

  it('rejects an extra direct planner stage write instead of promoting its artifact', async () => {
    const { projectDir, stateDir } = testProject('configured-direct-extra-write');
    const planner = await createConfiguredCustomPlanner(
      configuredPlanner({
        contract: 'direct',
        script: [
          "require('node:fs').writeFileSync(process.env.SPLITBRIEF_DECLARED_ARTIFACT_PATH, 'declared');",
          "require('node:fs').writeFileSync('undeclared-write.txt', 'reject');",
        ].join(''),
      }),
      runtimeFor({ projectDir, stateDir }),
    );

    await expect(
      planner.review('review this', projectDir, { onOutput: vi.fn() }),
    ).rejects.toMatchObject({ kind: 'custom-planner-artifact-invalid' });

    expect(existsSync(join(projectDir, 'undeclared-write.txt'))).toBe(false);
    expect(existsSync(join(projectDir, '.splitbrief-runner'))).toBe(false);
  });

  it('rejects a pre-existing artifact parent before the direct child starts', async () => {
    const { projectDir, stateDir } = testProject('configured-direct-existing-parent');
    const childSentinel = join(projectDir, 'child-started');
    let childStagePath = '';
    const planner = await createConfiguredCustomPlanner(
      configuredPlanner({
        contract: 'direct',
        script: `require('node:fs').writeFileSync(${JSON.stringify(childSentinel)}, 'started');`,
      }),
      runtimeFor({
        projectDir,
        stateDir,
        createStage: async (sourceProjectDir) => {
          const stage = await createStagedProject(sourceProjectDir);
          childStagePath = stage.projectDir;
          mkdirSync(join(stage.projectDir, '.splitbrief-runner'));
          return stage;
        },
      }),
    );

    await expect(
      planner.review('review this', projectDir, { onOutput: vi.fn() }),
    ).rejects.toMatchObject({ kind: 'custom-planner-artifact-invalid' });

    expect(existsSync(childSentinel)).toBe(false);
    expect(existsSync(childStagePath)).toBe(false);
  });

  itUnix('rejects a symlinked artifact parent before the direct child starts', async () => {
    const { projectDir, stateDir } = testProject('configured-direct-symlink-parent');
    const childSentinel = join(projectDir, 'child-started');
    const symlinkTarget = join(projectDir, 'symlink-target');
    let childStagePath = '';
    mkdirSync(symlinkTarget);
    const planner = await createConfiguredCustomPlanner(
      configuredPlanner({
        contract: 'direct',
        script: `require('node:fs').writeFileSync(${JSON.stringify(childSentinel)}, 'started');`,
      }),
      runtimeFor({
        projectDir,
        stateDir,
        createStage: async (sourceProjectDir) => {
          const stage = await createStagedProject(sourceProjectDir);
          childStagePath = stage.projectDir;
          symlinkSync(symlinkTarget, join(stage.projectDir, '.splitbrief-runner'));
          return stage;
        },
      }),
    );

    await expect(
      planner.review('review this', projectDir, { onOutput: vi.fn() }),
    ).rejects.toMatchObject({ kind: 'custom-planner-artifact-invalid' });

    expect(existsSync(childSentinel)).toBe(false);
    expect(existsSync(childStagePath)).toBe(false);
  });

  it('uses sourceEnv rather than a child stage sandbox environment for declared values', async () => {
    const { projectDir, stateDir } = testProject('configured-direct-source-env');
    const planner = await createConfiguredCustomPlanner(
      configuredPlanner({
        contract: 'direct',
        script: [
          "if (process.env.CUSTOM_PLANNER_CANARY !== 'only-from-source') process.exit(17);",
          "require('node:fs').writeFileSync(process.env.SPLITBRIEF_DECLARED_ARTIFACT_PATH, 'source env used');",
        ].join(''),
        env: ['CUSTOM_PLANNER_CANARY'],
      }),
      runtimeFor({
        projectDir,
        stateDir,
        sourceEnv: { CUSTOM_PLANNER_CANARY: 'only-from-source' },
        createStage: async (sourceProjectDir) => {
          const stage = await createStagedProject(sourceProjectDir);
          stage.sandboxEnv.CUSTOM_PLANNER_CANARY = 'only-from-stage';
          return stage;
        },
      }),
    );

    await expect(planner.review('review this', projectDir, { onOutput: vi.fn() })).resolves.toEqual(
      expect.objectContaining({ text: 'source env used' }),
    );
  });

  it('does not start a child when a declared sourceEnv value is missing', async () => {
    const { projectDir, stateDir } = testProject('configured-direct-missing-source-env');
    const childSentinel = join(projectDir, 'child-started');
    const planner = await createConfiguredCustomPlanner(
      configuredPlanner({
        contract: 'direct',
        script: `require('node:fs').writeFileSync(${JSON.stringify(childSentinel)}, 'started');`,
        env: ['CUSTOM_PLANNER_CANARY'],
      }),
      runtimeFor({
        projectDir,
        stateDir,
        sourceEnv: {},
        createStage: async (sourceProjectDir) => {
          const stage = await createStagedProject(sourceProjectDir);
          stage.sandboxEnv.CUSTOM_PLANNER_CANARY = 'only-from-stage';
          return stage;
        },
      }),
    );

    await expect(
      planner.review('review this', projectDir, { onOutput: vi.fn() }),
    ).rejects.toMatchObject({ kind: 'custom-runner-environment-missing' });

    expect(existsSync(childSentinel)).toBe(false);
  });

  it('rejects denied preparation before creating a planner or child stage', async () => {
    const { projectDir, stateDir } = testProject('configured-direct-admission-cleanup');
    await expect(
      createConfiguredCustomPlanner(
        configuredPlanner({
          contract: 'direct',
          script: "throw new Error('child must not start');",
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
    expect(existsSync(reviewCandidateRoot(projectDir))).toBe(false);
  });

  it('uses the supplied outer stage for direct full escalation without a nested stage', async () => {
    const { projectDir, stateDir } = testProject('configured-direct-full-escalation');
    const outerStage = await createStagedProject(projectDir);
    const staleReviewRoot = reviewCandidateRoot(projectDir);
    const stalePath = join(staleReviewRoot, 'stale-call', 'result');
    mkdirSync(join(staleReviewRoot, 'stale-call'), { recursive: true });
    writeFileSync(stalePath, 'stale');
    const planner = await createConfiguredCustomPlanner(
      configuredPlanner({
        contract: 'direct',
        script: [
          "require('node:fs').writeFileSync('full-escalation-change.txt', 'outer stage only');",
          "process.stdout.write('full escalation diagnostic');",
        ].join(''),
      }),
      runtimeFor({
        projectDir,
        stateDir,
        createStage: async () => {
          throw new Error('direct full escalation must not create a nested stage');
        },
        beginDeclaredArtifactReview: async () => {
          throw new Error('direct full escalation must not begin planner artifact review');
        },
      }),
    );

    try {
      await expect(
        planner.escalateFull({
          task: makeTask(),
          error: 'fix this',
          projectDir: outerStage.projectDir,
          callbacks: { onOutput: vi.fn() },
          fileIgnoreProjectDir: projectDir,
        }),
      ).resolves.toEqual(
        expect.objectContaining({
          success: true,
          output: expect.stringContaining('full escalation diagnostic'),
        }),
      );

      expect(existsSync(join(outerStage.projectDir, 'full-escalation-change.txt'))).toBe(true);
      expect(existsSync(join(projectDir, 'full-escalation-change.txt'))).toBe(false);
      expect(existsSync(stalePath)).toBe(false);
      expect(existsSync(staleReviewRoot)).toBe(false);
    } finally {
      outerStage.cleanup();
    }
  });
});
