import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Command } from 'commander';
import { readdirSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createTempDir, cleanupTempDir } from '#testing/helpers/temp-dir.js';
import { createTestGitRepo } from '#testing/helpers/git.js';
import { makePlanner } from '#testing/helpers/orchestrator-factories.js';
import { SPLITBRIEF_DIR, SPEC_FILE } from '../../core/paths.js';
import type { Config } from '../../core/schemas/config.js';
import type { Planner } from '../../engine/planners/types.js';
import {
  DECLARED_PLANNER_ARTIFACT_PATH,
  type ArtifactApprovalReview,
  type CustomRunnerRuntimePort,
} from '../../engine/runners/types.js';
import { registerSpecCommand } from './spec.js';

const createPlannerMock = vi.fn<(config: Config) => Promise<Planner>>();

let tmp: string;
let consoleSpy: ReturnType<typeof vi.spyOn>;
let originalIsTTY: boolean | undefined;

function setStdinIsTTY(value: boolean | undefined): void {
  Object.defineProperty(process.stdin, 'isTTY', { value, writable: true, configurable: true });
}

beforeEach(() => {
  tmp = realpathSync(createTempDir('spec-command-test'));
  createTestGitRepo(tmp);
  consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  originalIsTTY = process.stdin.isTTY;
  createPlannerMock.mockReset();
  createPlannerMock.mockResolvedValue(
    makePlanner({
      plan: vi.fn().mockResolvedValue({
        spec: '# Generated Spec',
        plan: '# Generated Plan',
        tasks: [],
        usage: null,
        phases: [{ text: '# Generated Spec', filename: SPEC_FILE }],
      }),
    }),
  );
});

afterEach(() => {
  setStdinIsTTY(originalIsTTY);
  if (tmp) cleanupTempDir(tmp);
  consoleSpy.mockRestore();
});

function sessionsRoot(): string {
  return join(tmp, SPLITBRIEF_DIR, 'sessions');
}

describe('spec command', () => {
  it('composes an interactive custom-runner runtime after creating the standalone session', async () => {
    setStdinIsTTY(true);
    let runtime: CustomRunnerRuntimePort | undefined;
    const disclosures: string[] = [];
    let reviewedArtifact: ArtifactApprovalReview | undefined;
    const program = new Command();
    program.exitOverride();
    registerSpecCommand(program, {
      createPlanner: async (config, _initialSessionId, options) => {
        runtime = options?.customRuntime;
        return createPlannerMock(config);
      },
      promptCustomRunnerDisclosure: async ({ request }) => {
        disclosures.push(request.actionDescription);
        return {
          decision: 'confirm',
          phrase: 'I confirm',
          reason: 'I reviewed the configured runner.',
        };
      },
      promptCustomRunnerArtifactApproval: async (review) => {
        reviewedArtifact = review;
        return { approved: true };
      },
    });

    await program.parseAsync([
      'node',
      'splitbrief',
      'spec',
      '--project',
      tmp,
      '--allow-hooks',
      'add health endpoint',
    ]);

    if (runtime === undefined) throw new Error('expected standalone custom runner runtime');
    const onTieredApproval = runtime.admission.onTieredApproval;
    if (onTieredApproval === undefined) throw new Error('expected interactive disclosure callback');
    const disclosure = await onTieredApproval({
      tier: 'confirm',
      actionClass: 'network',
      actionDescription: 'Review configured runner disclosure',
      phase: 'planning',
    });
    const stage = await runtime.createStage(tmp, 'planner');
    try {
      const review = await runtime.beginDeclaredArtifactReview({
        stagedProjectDir: stage.projectDir,
        callId: 'call-1',
        declaredRedactionValues: [],
      });
      try {
        writeFileSync(join(stage.projectDir, DECLARED_PLANNER_ARTIFACT_PATH), 'interactive result');
        expect(await review.reviewAfterChild()).toBe('interactive result');
      } finally {
        await review.dispose();
      }
    } finally {
      stage.cleanup();
      await runtime.cleanupStaleArtifactReviews();
    }

    expect(readdirSync(sessionsRoot())).toContain(runtime.sessionId);
    expect(runtime.authorizationProjectDir).toBe(tmp);
    expect(runtime.admission).toMatchObject({
      interaction: 'interactive',
      allowRepoRunners: false,
    });
    expect(disclosure).toMatchObject({ decision: 'confirm', phrase: 'I confirm' });
    expect(disclosures).toEqual(['Review configured runner disclosure']);
    expect(reviewedArtifact).toEqual({
      label: 'Custom planner artifact',
      text: 'interactive result',
    });
    expect(reviewedArtifact).not.toHaveProperty('filePath');
  });

  it('uses headless custom-runner admission and explicit repo-runner grant without prompts', async () => {
    setStdinIsTTY(false);
    let runtime: CustomRunnerRuntimePort | undefined;
    const program = new Command();
    program.exitOverride();
    registerSpecCommand(program, {
      createPlanner: async (config, _initialSessionId, options) => {
        runtime = options?.customRuntime;
        return createPlannerMock(config);
      },
      promptCustomRunnerDisclosure: async () => {
        throw new Error('headless standalone spec must not prompt for disclosure');
      },
      promptCustomRunnerArtifactApproval: async () => {
        throw new Error('headless standalone spec must not prompt for artifact approval');
      },
    });

    await program.parseAsync([
      'node',
      'splitbrief',
      'spec',
      '--project',
      tmp,
      '--allow-hooks',
      '--allow-repo-runners',
      'add health endpoint',
    ]);

    if (runtime === undefined) throw new Error('expected standalone custom runner runtime');
    expect(runtime.admission).toMatchObject({ interaction: 'headless', allowRepoRunners: true });
    expect(runtime.admission.onTieredApproval).toBeUndefined();
    const stage = await runtime.createStage(tmp, 'planner');
    try {
      const review = await runtime.beginDeclaredArtifactReview({
        stagedProjectDir: stage.projectDir,
        callId: 'call-2',
        declaredRedactionValues: [],
      });
      try {
        writeFileSync(join(stage.projectDir, DECLARED_PLANNER_ARTIFACT_PATH), 'headless result');
        await expect(review.reviewAfterChild()).resolves.toBe('headless result');
      } finally {
        await review.dispose();
      }
    } finally {
      stage.cleanup();
      await runtime.cleanupStaleArtifactReviews();
    }
  });
});
