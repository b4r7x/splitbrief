import type { Command } from 'commander';
import ansis from 'ansis';
import { createPlanner } from '../../engine/runners/factory.js';
import type { Planner, PlanResult } from '../../engine/planners/types.js';
import type { Phase } from '../../core/schemas/enums.js';
import { getRunnerDisplayName } from '../../core/config/accessors/runner-config.js';
import { ensureGitAndConfig, resolveProjectDir, loadConfigOrExit } from '../setup.js';
import { withCliErrors } from '../errors.js';
import { printConfigWarnings } from '../build-overrides.js';
import { SPEC_FILE, PLAN_FILE, TASKS_FILE, sessionDir } from '../../core/paths.js';
import { writeSpecFile } from '../../core/paths-io.js';
import { ensureHooksTrusted } from '../hook-trust-prompt.js';
import { resolveHooksConfig } from '../../engine/hooks/discover.js';
import { stripTerminalControls } from '../../utils/display-text.js';
import type {
  ArtifactApprovalReview,
  CustomRunnerRuntimePort,
} from '../../engine/runners/types.js';
import { createStagedProject } from '../../engine/orchestrator/approval/staged-project.js';
import {
  beginDeclaredArtifactReview,
  cleanupStaleArtifactReviews,
} from '../../engine/orchestrator/approval/planner-artifact.js';
import {
  promptCustomRunnerArtifactApproval,
  promptCustomRunnerDisclosure,
} from '../custom-runner-prompts.js';
import { ALLOW_REPO_RUNNERS_HELP } from '../options.js';
import { prepareExecution } from '../../engine/runners/prepare-execution.js';
import {
  releasePreparedExecutionOwnership,
  rollbackPreparedExecutionOwnership,
} from '../../engine/runners/prepared-execution.js';
import {
  cliPreparationPolicy,
  clearStaleSessionForCli,
  preparedExecutionOrThrow,
} from './start/readiness.js';

type SpecOpts = { project?: string; allowHooks: boolean; allowRepoRunners: boolean };

interface SpecCommandDeps {
  createPlanner?: typeof createPlanner | undefined;
  prepareExecution?: typeof prepareExecution | undefined;
  promptCustomRunnerDisclosure?: typeof promptCustomRunnerDisclosure | undefined;
  promptCustomRunnerArtifactApproval?: typeof promptCustomRunnerArtifactApproval | undefined;
}

export function registerSpecCommand(program: Command, deps: SpecCommandDeps = {}): void {
  const createPlannerForCommand = deps.createPlanner ?? createPlanner;
  const prepareForCommand = deps.prepareExecution ?? prepareExecution;
  const promptForDisclosure = deps.promptCustomRunnerDisclosure ?? promptCustomRunnerDisclosure;
  const promptForArtifactApproval =
    deps.promptCustomRunnerArtifactApproval ?? promptCustomRunnerArtifactApproval;
  program
    .command('spec <feature>')
    .description('Generate spec, plan, and tasks only (no implementation)')
    .option('--project <dir>', 'Project directory (default: cwd)')
    .option('--allow-hooks', 'Trust hook config without prompting (use in CI)', false)
    .option('--allow-repo-runners', ALLOW_REPO_RUNNERS_HELP, false)
    .action(async (feature: string, opts: SpecOpts) => {
      const projectDir = resolveProjectDir(opts.project);
      await ensureGitAndConfig(projectDir);

      clearStaleSessionForCli(projectDir, 'defer-to-preparation');

      const { config: baseConfig, warnings } = loadConfigOrExit(projectDir);
      const mergedHooks = await resolveHooksConfig(projectDir, baseConfig.hooks);
      await ensureHooksTrusted({ projectDir, hooks: mergedHooks, allowHooks: opts.allowHooks });
      printConfigWarnings(warnings);

      const interaction = process.stdin.isTTY ? 'interactive' : 'headless';
      const execution = preparedExecutionOrThrow(
        await prepareForCommand({
          projectDir,
          feature,
          effectiveConfig: baseConfig,
          policy: cliPreparationPolicy({
            purpose: 'spec',
            interaction,
            opts,
            ...(interaction === 'interactive' && {
              onTieredApproval: (request) => promptForDisclosure({ request }),
            }),
          }),
          signal: new AbortController().signal,
        }),
        interaction === 'headless',
      );
      const sessionId = execution.session.ref.sessionId;
      const sourceEnv = { ...process.env };
      const authorizationPathEnv = process.env.PATH;
      const authorizationPathExt = process.env.PATHEXT;
      const onArtifactApprovalNeeded = (_type: 'artifact', review: ArtifactApprovalReview) =>
        interaction === 'interactive'
          ? promptForArtifactApproval(review)
          : Promise.resolve({ approved: true as const });
      const customRuntime: CustomRunnerRuntimePort = {
        sessionId,
        authorizationProjectDir: projectDir,
        sourceEnv,
        ...(authorizationPathEnv === undefined ? {} : { authorizationPathEnv }),
        ...(authorizationPathExt === undefined ? {} : { authorizationPathExt }),
        createStage: async (sourceProjectDir, _role) => {
          const staged = await createStagedProject(sourceProjectDir);
          return {
            projectDir: staged.projectDir,
            snapshot: staged.snapshot,
            cleanup: staged.cleanup,
          };
        },
        cleanupStaleArtifactReviews: () => cleanupStaleArtifactReviews({ projectDir, sessionId }),
        beginDeclaredArtifactReview: (artifactInput) =>
          beginDeclaredArtifactReview({
            ...artifactInput,
            projectDir,
            sessionId,
            onApprovalNeeded: onArtifactApprovalNeeded,
          }),
        admission: {
          interaction,
          allowRepoRunners: opts.allowRepoRunners,
          ...(interaction === 'interactive'
            ? { onTieredApproval: (request) => promptForDisclosure({ request }) }
            : {}),
        },
      };

      let planner: Planner;
      try {
        planner = await createPlannerForCommand(execution.config, {
          initialSessionId: undefined,
          preparedConfig: execution.config,
          customRuntime,
          preparationId: execution.preparationId,
          gates: execution.gates,
          slot: { role: 'planner' },
        });
      } catch (cause) {
        rollbackPreparedExecutionOwnership(execution);
        throw cause;
      }

      console.log(
        `Planning feature: ${feature} (planner: ${getRunnerDisplayName(baseConfig.planner)})\n`,
      );

      releasePreparedExecutionOwnership(execution);
      const result: PlanResult = await withCliErrors(() =>
        planner.plan({
          feature: execution.runtime.feature,
          projectDir,
          callbacks: {
            onOutput(text: string) {
              process.stdout.write(stripTerminalControls(text));
            },
            onPhase(phase: Phase) {
              console.log(`\n${ansis.bold(`--- ${phase} ---`)}\n`);
            },
            sessionId,
          },
        }),
      );

      for (const phase of result.phases ?? []) {
        writeSpecFile({ projectDir, sessionId }, phase.filename, phase.text);
      }

      const sessionPath = sessionDir(projectDir, sessionId);
      console.log('\nSpec generation complete.');
      console.log(`  Session: ${ansis.dim(sessionId)}`);
      console.log(`  Spec:  ${ansis.dim(`${sessionPath}/${SPEC_FILE}`)}`);
      console.log(`  Plan:  ${ansis.dim(`${sessionPath}/${PLAN_FILE}`)}`);
      console.log(
        `  Tasks: ${ansis.dim(`${sessionPath}/${TASKS_FILE}`)} (${result.tasks.length} tasks)`,
      );
    });
}
