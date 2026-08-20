import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Command } from 'commander';
import { readdirSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  activateCompatibleCliShim,
  installCompatibleCliShim,
} from '#testing/helpers/compatible-cli-shim.js';
import { createTempDir, cleanupTempDir } from '#testing/helpers/temp-dir.js';
import { createTestGitRepo } from '#testing/helpers/git.js';
import { makePlanner } from '#testing/helpers/orchestrator-factories.js';
import { SPLITBRIEF_DIR, SPEC_FILE } from '../../core/paths.js';
import { defaultCliAuthChannel } from '../../core/runners/cli-tool-catalog.js';
import {
  createTaskCompilationAttemptId,
  OwnedPlannerArtifactSchema,
  TaskCompilationSemanticIdSchema,
} from '../../core/schemas/task-compilation.js';
import type { Config } from '../../core/schemas/config.js';
import type {
  PhaseResult,
  Planner,
  PlannerArtifactLogicalName,
} from '../../engine/planners/types.js';
import type {
  ArtifactApprovalReview,
  CustomRunnerRuntimePort,
} from '../../engine/runners/types.js';
import { sha256Hex } from '../../utils/sha256.js';
import { registerSpecCommand } from './spec.js';

const createPlannerMock = vi.fn<(config: Config) => Promise<Planner>>();

let tmp: string;
let shimDir: string;
let restoreCompatibleCliShim: (() => void) | undefined;
let consoleSpy: ReturnType<typeof vi.spyOn>;
let originalIsTTY: boolean | undefined;

function phaseResult(logicalName: PlannerArtifactLogicalName, text: string): PhaseResult {
  const digest = sha256Hex(text);
  return {
    artifact: OwnedPlannerArtifactSchema.parse({
      semanticId: `test-${logicalName}`,
      programId: null,
      batchId: null,
      attemptId: createTaskCompilationAttemptId(),
      logicalName,
      transport: 'stdout-final',
      text,
      byteLength: Buffer.byteLength(text, 'utf8'),
      sha256: digest,
      runtimeReceipt: digest,
      terminal: { status: 'completed', recordId: `test-${logicalName}`, protocolDigest: digest },
      sourceReceipt: { kind: 'stdout-final', resultDigest: digest },
    }),
  };
}

function setStdinIsTTY(value: boolean | undefined): void {
  Object.defineProperty(process.stdin, 'isTTY', { value, writable: true, configurable: true });
}

beforeEach(() => {
  tmp = realpathSync(createTempDir('spec-command-test'));
  createTestGitRepo(tmp);
  // The configured planner is injected, but the readiness gate still probes
  // the config's CLI tool. Without a shim these assertions depend on whether
  // the developer's own machine is signed in to Claude Code.
  shimDir = createTempDir('spec-runtime-shim');
  restoreCompatibleCliShim = activateCompatibleCliShim(
    installCompatibleCliShim({
      directory: shimDir,
      tool: 'claude-code',
      authChannel: defaultCliAuthChannel('claude-code').id,
    }),
    'test-only-spec-runtime-shim-key',
  );
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
        phases: [phaseResult(SPEC_FILE, '# Generated Spec')],
      }),
    }),
  );
});

afterEach(() => {
  restoreCompatibleCliShim?.();
  restoreCompatibleCliShim = undefined;
  cleanupTempDir(shimDir);
  setStdinIsTTY(originalIsTTY);
  if (tmp) cleanupTempDir(tmp);
  consoleSpy.mockRestore();
});

function sessionsRoot(): string {
  return join(tmp, SPLITBRIEF_DIR, 'sessions');
}

describe('spec command', () => {
  it('spec prepares only its configured planner before session creation', async () => {
    setStdinIsTTY(false);
    let gates: readonly unknown[] = [];
    const program = new Command();
    program.exitOverride();
    registerSpecCommand(program, {
      createPlanner: async (config, options) => {
        gates = options.gates;
        return createPlannerMock(config);
      },
    });

    await program.parseAsync([
      'node',
      'splitbrief',
      'spec',
      '--project',
      tmp,
      '--allow-hooks',
      'prepare planner only',
    ]);

    expect(gates).toHaveLength(1);
    expect(gates[0]).toMatchObject({ slot: { role: 'planner' } });
    expect(readdirSync(sessionsRoot())).toHaveLength(1);
  });

  it('composes an interactive custom-runner runtime after creating the standalone session', async () => {
    setStdinIsTTY(true);
    let runtime: CustomRunnerRuntimePort | undefined;
    const disclosures: string[] = [];
    let reviewedArtifact: ArtifactApprovalReview | undefined;
    const program = new Command();
    program.exitOverride();
    registerSpecCommand(program, {
      createPlanner: async (config, options) => {
        runtime = options.customRuntime;
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
      const attemptId = createTaskCompilationAttemptId();
      const relativePath = `.splitbrief-runner/output/${attemptId}/result`;
      const review = await runtime.beginDeclaredArtifactReview({
        stagedProjectDir: stage.projectDir,
        callId: 'call-1',
        declaredRedactionValues: [],
        provenance: {
          semanticId: TaskCompilationSemanticIdSchema.parse('interactive-runtime-artifact'),
          programId: null,
          batchId: null,
          attemptId,
          transport: {
            kind: 'declared-file',
            lease: { leaseId: attemptId, attemptId, relativePath },
          },
          maxBytes: 96 * 1_024,
          relativePath,
        },
      });
      try {
        writeFileSync(join(stage.projectDir, relativePath), 'interactive result');
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
      createPlanner: async (config, options) => {
        runtime = options.customRuntime;
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
      const attemptId = createTaskCompilationAttemptId();
      const relativePath = `.splitbrief-runner/output/${attemptId}/result`;
      const review = await runtime.beginDeclaredArtifactReview({
        stagedProjectDir: stage.projectDir,
        callId: 'call-2',
        declaredRedactionValues: [],
        provenance: {
          semanticId: TaskCompilationSemanticIdSchema.parse('headless-runtime-artifact'),
          programId: null,
          batchId: null,
          attemptId,
          transport: {
            kind: 'declared-file',
            lease: { leaseId: attemptId, attemptId, relativePath },
          },
          maxBytes: 96 * 1_024,
          relativePath,
        },
      });
      try {
        writeFileSync(join(stage.projectDir, relativePath), 'headless result');
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
