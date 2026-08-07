import { randomUUID } from 'node:crypto';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { makeConfig } from '#testing/helpers/factories/config.js';
import { makeTask } from '#testing/helpers/factories/task.js';
import { createTestGitRepo } from '#testing/helpers/git.js';
import { makeCallbacks, makePlanner } from '#testing/helpers/orchestrator-factories.js';
import { withTempDir } from '#testing/helpers/temp-dir.js';
import { ConfigSchema } from '../../../core/schemas/config.js';
import type { ReadinessReport } from '../../../core/readiness/types.js';
import { SANDBOX_DIR } from '../../../core/paths.js';
import { DECLARED_PLANNER_ARTIFACT_PATH } from '../../runners/types.js';
import { composeWorkflowCustomRunnerRuntime, initializeWorkflow } from './init.js';
import { createRunIsolation } from '../isolation/create.js';
import type { RunIsolation } from '../isolation/types.js';
import { prepareCustomRunnerAdmission } from '../../runners/custom-admission.js';
import { customRunnerSecurityPosture } from '../../runners/custom-trust.js';
import { resolveConfiguredCustomRunner } from '../../runners/configured-custom.js';
import {
  parsePreparedConfig,
  type PreparedExecution,
  type RunnerGate,
  type RunnerSlot,
} from '../../runners/prepared-execution.js';

function makeCopyingIsolation(projectDir: string, sessionId: string): RunIsolation {
  return createRunIsolation({
    projectDir,
    sessionId,
    strategy: 'staged-copy',
    onFallback: () => {},
    onRetained: () => {},
  });
}

function readyReport(projectDir: string): ReadinessReport {
  return {
    generatedAt: new Date(0).toISOString(),
    projectDir,
    status: 'ready',
    counts: { ok: 1, info: 0, warning: 0, blocker: 0 },
    nextAction: { kind: 'continue', label: 'Continue', reason: 'ready' },
    sections: [],
    metadata: {},
  };
}

async function configuredGate(
  input: Readonly<{
    projectDir: string;
    config: ReturnType<typeof parsePreparedConfig>;
    role: 'planner' | 'implementer';
    slot: RunnerSlot;
    preparationId: string;
  }>,
): Promise<RunnerGate> {
  const runner = resolveConfiguredCustomRunner(input.config, input.role);
  if (runner === null) throw new Error(`Expected a configured ${input.role} runner.`);
  const admission = await prepareCustomRunnerAdmission({
    projectDir: input.projectDir,
    runner,
    posture: customRunnerSecurityPosture(input.role, runner.command.contract),
    phase: input.role === 'planner' ? 'planning' : 'implementing',
    interaction: 'headless',
    allowRepoRunners: true,
    authorizationPathEnv: process.env.PATH ?? '',
    authorizationPathExt: process.env.PATHEXT ?? '',
  });
  if (admission.kind !== 'admitted') throw new Error('Configured runner was not admitted.');
  return {
    kind: runner.command.contract === 'output' ? 'shell' : 'agent',
    slot: input.slot,
    preparationId: input.preparationId,
    command: { kind: 'configured-custom', invocation: admission.invocation },
  };
}

function preparedExecution(
  input: Readonly<{
    projectDir: string;
    feature: string;
    sessionId: string;
    config: ReturnType<typeof parsePreparedConfig>;
    preparationId: string;
    gates: readonly RunnerGate[];
  }>,
): PreparedExecution {
  const active = {
    version: 1 as const,
    sessionId: input.sessionId,
    generation: randomUUID(),
  };
  return {
    purpose: 'new-workflow',
    config: input.config,
    preparationId: input.preparationId,
    report: readyReport(input.projectDir),
    gates: input.gates,
    session: {
      kind: 'existing',
      ref: { projectDir: input.projectDir, sessionId: active.sessionId },
      active,
    },
    runtime: {
      feature: input.feature,
      allowRepoRunners: true,
      allowHooks: true,
    },
  };
}

describe('configured custom workflow runtime', () => {
  it('composes independent host authority snapshots while withholding stage sandbox state', async () => {
    await withTempDir('splitbrief-custom-runtime-composition', async (projectDir) => {
      createTestGitRepo(projectDir);
      const originalCanary = process.env.CUSTOM_RUNTIME_SOURCE_CANARY;
      const originalPath = process.env.PATH;
      const tieredApproval = async () => ({ decision: 'deny' as const, reason: 'not now' });
      const callbacks = {
        onApprovalNeeded: async () => ({ approved: false as const }),
        onTieredApproval: tieredApproval,
      };
      try {
        process.env.CUSTOM_RUNTIME_SOURCE_CANARY = 'source-only-canary';
        const authorizationPath = process.env.PATH;
        const headless = composeWorkflowCustomRunnerRuntime({
          projectDir,
          sessionId: 'headless-runtime',
          callbacks,
          interaction: 'headless',
          allowRepoRunners: true,
        });
        const interactive = composeWorkflowCustomRunnerRuntime({
          projectDir,
          sessionId: 'interactive-runtime',
          callbacks,
          interaction: 'interactive',
          allowRepoRunners: false,
        });
        const stage = await headless.createStage(projectDir, 'planner');
        try {
          process.env.CUSTOM_RUNTIME_SOURCE_CANARY = 'mutated-after-composition';
          process.env.PATH = '/competing-child-path';
          expect(headless.sourceEnv.CUSTOM_RUNTIME_SOURCE_CANARY).toBe('source-only-canary');
          expect(headless.authorizationPathEnv).toBe(authorizationPath);
          expect(headless.admission).toMatchObject({
            interaction: 'headless',
            allowRepoRunners: true,
          });
          expect(interactive.admission).toMatchObject({
            interaction: 'interactive',
            allowRepoRunners: false,
            onTieredApproval: tieredApproval,
          });
          expect(stage.projectDir).not.toBe(projectDir);
          expect('sandboxEnv' in stage).toBe(false);
        } finally {
          stage.cleanup();
        }
      } finally {
        if (originalCanary === undefined) delete process.env.CUSTOM_RUNTIME_SOURCE_CANARY;
        else process.env.CUSTOM_RUNTIME_SOURCE_CANARY = originalCanary;
        if (originalPath === undefined) delete process.env.PATH;
        else process.env.PATH = originalPath;
      }
    });
  });
  it('keeps host CLI session credentials out of dynamically-created configured runner stages with a distinct config', async () => {
    await withTempDir('splitbrief-configured-stage-project', async (projectDir) => {
      await withTempDir('splitbrief-configured-stage-home', async (hostHome) => {
        createTestGitRepo(projectDir);
        const evidencePath = join(hostHome, 'stage-evidence.json');
        const originalHome = process.env.HOME;
        const originalEvidencePath = process.env.R2_STAGE_EVIDENCE;
        const sessionCanary = 'r2-session-auth-canary';
        try {
          await mkdir(join(hostHome, '.codex'), { recursive: true });
          await writeFile(join(hostHome, '.codex', 'auth.json'), sessionCanary);
          process.env.HOME = hostHome;
          process.env.R2_STAGE_EVIDENCE = evidencePath;

          const childProgram = [
            "const fs = require('node:fs');",
            "const path = require('node:path');",
            `const authPath = path.join(process.cwd(), ${JSON.stringify(SANDBOX_DIR)}, 'home', '.codex', 'auth.json');`,
            "fs.writeFileSync(process.env.R2_STAGE_EVIDENCE, JSON.stringify({ cwd: process.cwd(), auth: fs.existsSync(authPath) ? fs.readFileSync(authPath, 'utf8') : null }));",
            "process.stdout.write('```ts\\nexport const staged = true;\\n```\\n');",
          ].join('');
          const command = {
            label: 'R2 staged custom runner',
            contract: 'output' as const,
            executable: process.execPath,
            argv: ['-e', childProgram],
            outputFormat: 'text' as const,
            idleWarnMs: 300_000,
            idleKillMs: 1_800_000,
            env: ['R2_STAGE_EVIDENCE'],
          };
          const configuredRunner = {
            kind: 'shell' as const,
            command: command.executable,
            args: command.argv,
            outputFormat: command.outputFormat,
            idleWarnMs: command.idleWarnMs,
            idleKillMs: command.idleKillMs,
            env: command.env,
            model: 'r2-custom-model',
          };
          const baseConfig = ConfigSchema.parse(
            makeConfig({
              implementer: { kind: 'cli', tool: 'codex', authChannel: 'session' },
              validation: { typecheck: false, lint: false, test: false, testCommand: 'noop' },
              workflow: { mode: 'quick', persistTranscript: false },
              approval: { enabled: false, feedRejectionsToPlanner: true },
              codebase: { enabled: false, tokenBudget: 4000, cacheDir: '.splitbrief' },
            }),
          );
          const dynamicConfig = ConfigSchema.parse({
            ...baseConfig,
            implementerProfiles: {
              default: 'configured-output',
              profiles: { 'configured-output': configuredRunner },
            },
            customCommands: { 'r2-configured-output': command },
          });
          const { callbacks } = makeCallbacks();
          const sessionId = 'r2-configured-stage';
          const config = parsePreparedConfig(dynamicConfig);
          const preparationId = 'r2-configured-stage';
          const gates = [
            await configuredGate({
              projectDir,
              config,
              role: 'implementer',
              slot: { role: 'implementer', profile: 'configured-output' },
              preparationId,
            }),
          ];
          const init = await initializeWorkflow({
            opts: {
              prepared: preparedExecution({
                projectDir,
                feature: 'exercise a configured output runner',
                sessionId,
                config,
                preparationId,
                gates,
              }),
              callbacks,
              sinks: { setAbortHandler: () => {}, setQueueHandler: () => {} },
              _planner: makePlanner(),
              headless: true,
            },
            config,
            sessionId,
            summaryBase: {
              feature: 'exercise a configured output runner',
              startTime: Date.now(),
              plannerTool: 'test-planner',
              implementerTool: 'configured-output',
              mode: 'quick',
              projectDir,
              sessionId,
            },
            metadata: {
              plannerTool: 'test-planner',
              implementerTool: 'configured-output',
              mode: 'quick',
            },
            setTrackedState: () => {},
            resumeHolder: { messages: [] },
            isolation: makeCopyingIsolation(projectDir, sessionId),
          });

          expect(init.ok).toBe(true);
          if (!init.ok) return;

          const createDynamicImplementer = init.wctx.createImplementer;
          if (createDynamicImplementer === undefined) {
            throw new Error('expected a dynamic implementer factory');
          }
          const dynamicImplementer = await createDynamicImplementer(config, {
            slot: { role: 'implementer', profile: 'configured-output' },
          });
          const result = await dynamicImplementer.implement({
            task: makeTask({ file: 'src/dynamic-stage.ts' }),
            projectDir,
            config,
            context: { name: 'r2-stage-project', dir: projectDir },
            onOutput: () => {},
          });

          expect(result.success).toBe(true);
          expect(await readFile(join(projectDir, 'src', 'dynamic-stage.ts'), 'utf8')).toContain(
            'export const staged = true;',
          );
          const stageEvidence = JSON.parse(await readFile(evidencePath, 'utf8'));
          expect(stageEvidence.auth).toBeNull();
          expect(stageEvidence.cwd).not.toBe(projectDir);
        } finally {
          if (originalHome === undefined) delete process.env.HOME;
          else process.env.HOME = originalHome;
          if (originalEvidencePath === undefined) delete process.env.R2_STAGE_EVIDENCE;
          else process.env.R2_STAGE_EVIDENCE = originalEvidencePath;
        }
      });
    });
  });
  it('keeps configured custom runners available to primary and dynamic workflow factories', async () => {
    await withTempDir('splitbrief-init-configured-custom-runners', async (projectDir) => {
      const feature = 'use configured custom runners';
      const sessionId = 'session-init-configured-custom-runners';
      const command = (label: string, argv: string[]) => ({
        label,
        contract: 'output' as const,
        executable: process.execPath,
        argv,
        outputFormat: 'text' as const,
        idleWarnMs: 300_000,
        idleKillMs: 1_800_000,
        env: [],
      });
      const runner = (configured: ReturnType<typeof command>, model: string) => ({
        kind: 'shell' as const,
        command: configured.executable,
        args: configured.argv,
        outputFormat: configured.outputFormat,
        idleWarnMs: configured.idleWarnMs,
        idleKillMs: configured.idleKillMs,
        env: configured.env,
        model,
      });
      const implementerCommand = command('Workflow configured runner', []);
      const plannerCommand = command('Workflow configured planner', ['--workflow-planner']);
      const config = ConfigSchema.parse({
        ...makeConfig({
          implementer: { kind: 'agent', command: 'cat', outputFormat: 'text', model: 'legacy' },
          validation: { typecheck: false, lint: false, test: false, testCommand: 'noop' },
          workflow: { mode: 'quick', persistTranscript: false },
          approval: { enabled: false, feedRejectionsToPlanner: true },
        }),
        planner: runner(plannerCommand, 'configured planner'),
        implementerProfiles: {
          default: 'configured-custom',
          profiles: { 'configured-custom': runner(implementerCommand, 'configured') },
        },
        customCommands: {
          'workflow-implementer': implementerCommand,
          'workflow-planner': plannerCommand,
        },
      });
      const { callbacks } = makeCallbacks();
      const preparedConfig = parsePreparedConfig(config);
      const preparationId = 'session-init-configured-custom-runners';
      const gates = await Promise.all([
        configuredGate({
          projectDir,
          config: preparedConfig,
          role: 'planner',
          slot: { role: 'planner' },
          preparationId,
        }),
        configuredGate({
          projectDir,
          config: preparedConfig,
          role: 'implementer',
          slot: { role: 'implementer', profile: 'configured-custom' },
          preparationId,
        }),
      ]);
      const init = await initializeWorkflow({
        opts: {
          prepared: preparedExecution({
            projectDir,
            feature,
            sessionId,
            config: preparedConfig,
            preparationId,
            gates,
          }),
          callbacks,
          sinks: { setAbortHandler: () => {}, setQueueHandler: () => {} },
        },
        config: preparedConfig,
        sessionId,
        summaryBase: {
          feature,
          startTime: Date.now(),
          plannerTool: 'configured planner',
          implementerTool: 'configured implementer',
          mode: 'quick',
          projectDir,
          sessionId,
        },
        metadata: {
          plannerTool: 'configured planner',
          implementerTool: 'configured implementer',
          mode: 'quick',
        },
        setTrackedState: () => {},
        resumeHolder: { messages: [] },
        isolation: makeCopyingIsolation(projectDir, sessionId),
      });
      expect(init.ok).toBe(true);
      if (!init.ok) return;
      expect(init.wctx.planner.capabilities.supportsSelfSummarisation).toBe(false);
      expect(init.wctx.implementer.capabilities).toEqual({ writesFiles: 'extracted-code' });
      expect(
        (
          await init.wctx.createImplementer?.(preparedConfig, {
            slot: { role: 'implementer', profile: 'configured-custom' },
          })
        )?.capabilities,
      ).toEqual({
        writesFiles: 'extracted-code',
      });
    });
  });
  it('delivers declared artifact reviews as immutable text rather than a stage path', async () => {
    await withTempDir('splitbrief-runtime-artifact-review', async (projectDir) => {
      createTestGitRepo(projectDir);
      const reviewedArtifacts: Array<{ label: string; text: string }> = [];
      const runtime = composeWorkflowCustomRunnerRuntime({
        projectDir,
        sessionId: 'runtime-artifact-session',
        callbacks: {
          onApprovalNeeded: async (_type, input) => {
            if (typeof input === 'string') throw new Error('expected an immutable artifact review');
            reviewedArtifacts.push(input);
            return { approved: true as const };
          },
        },
        interaction: 'headless',
        allowRepoRunners: true,
      });

      await runtime.cleanupStaleArtifactReviews();
      const stage = await runtime.createStage(projectDir, 'planner');
      let review: Awaited<ReturnType<typeof runtime.beginDeclaredArtifactReview>> | undefined;
      try {
        review = await runtime.beginDeclaredArtifactReview({
          stagedProjectDir: stage.projectDir,
          callId: 'call-1',
          declaredRedactionValues: [],
        });
        await writeFile(join(stage.projectDir, DECLARED_PLANNER_ARTIFACT_PATH), 'workflow result');
        await expect(review.reviewAfterChild()).resolves.toBe('workflow result');
      } finally {
        if (review !== undefined) await review.dispose();
        stage.cleanup();
        await runtime.cleanupStaleArtifactReviews();
      }

      expect(reviewedArtifacts).toEqual([
        { label: 'Custom planner artifact', text: 'workflow result' },
      ]);
      expect(Object.isFrozen(reviewedArtifacts[0])).toBe(true);
    });
  });
});
