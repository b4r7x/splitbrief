import type { Command } from 'commander';
import ansis from 'ansis';
import { createPlanner } from '../../engine/runners/factory.js';
import { compilerDriftWarning } from '../../engine/runners/compiler-drift-warning.js';
import type { Planner, PlanOptions, PlanResult } from '../../engine/planners/types.js';
import type { Phase, WorkflowMode } from '../../core/schemas/enums.js';
import { getRunnerDisplayName } from '../../core/config/accessors/runner-config.js';
import { getWorkflowMode } from '../../core/config/accessors/values.js';
import { ensureGitAndConfig, canonicalizeProjectDir, loadConfigOrExit } from '../setup.js';
import { withCliErrors } from '../errors.js';
import { TASKS_FILE, sessionDir } from '../../core/paths.js';
import { writeSpecFile } from '../../core/paths-io.js';
import { ensureHooksTrusted } from '../hook-trust-prompt.js';
import { warnStderr } from '../../lib/warn.js';
import { sanitizeTerminalDisplayText, stripTerminalControls } from '../../utils/display-text.js';
import {
  emitEffectiveConfigWarnings,
  resolveEffectiveConfig,
  type EffectiveConfigWarning,
} from '../../core/config/runtime/effective-config.js';
import { workflowOptsToCLIOverrides } from '../../core/config/runtime/overrides/from-options.js';
import { assertNever } from '../../utils/type-guards.js';
import type { ArtifactApprovalReview } from '../../engine/runners/types.js';
import { createCustomRunnerRuntime } from '../../engine/runners/custom-runner-runtime.js';
import {
  promptCustomRunnerArtifactApproval,
  promptCustomRunnerDisclosure,
} from '../custom-runner-prompts.js';
import { ALLOW_REPO_RUNNERS_HELP } from '../options.js';
import { prepareExecution } from '../../engine/runners/prepare-execution/prepare-execution.js';
import {
  releasePreparedExecutionOwnership,
  rollbackPreparedExecutionOwnership,
} from '../../engine/runners/prepared-execution.js';
import {
  cliPreparationPolicy,
  clearStaleSessionForCli,
  preparedExecutionOrThrow,
} from './start/readiness.js';

type SpecOpts = {
  project?: string;
  allowHooks: boolean;
  allowRepoRunners: boolean;
  mode?: WorkflowMode;
};

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
    .option('--mode <mode>', 'Workflow mode: quick, standard, or speckit')
    .option('--project <dir>', 'Project directory (default: cwd)')
    .option('--allow-hooks', 'Trust hook config without prompting (use in CI)', false)
    .option('--allow-repo-runners', ALLOW_REPO_RUNNERS_HELP, false)
    .action(async (feature: string, opts: SpecOpts) => {
      const projectDir = await canonicalizeProjectDir(opts);
      await ensureGitAndConfig(projectDir);

      clearStaleSessionForCli(projectDir);

      const loaded = loadConfigOrExit(projectDir);
      await ensureHooksTrusted({
        projectDir,
        hooks: loaded.config.hooks,
        allowHooks: opts.allowHooks,
      });
      const { config, warnings } = resolveEffectiveConfig({
        base: loaded.config,
        overrides: workflowOptsToCLIOverrides(opts),
        loaderDiagnostics: loaded.loaderDiagnostics,
      });
      // Load-time validation sees the raw file; resolveEffectiveConfig re-validates an
      // already-preprocessed config, so notices about retired values are only on this side.
      emitEffectiveConfigWarnings([
        ...warnings,
        ...loaded.warnings.map(
          (message): EffectiveConfigWarning => ({ source: 'validation', message }),
        ),
      ]);
      const mode = getWorkflowMode(config);

      const interaction = process.stdin.isTTY ? 'interactive' : 'headless';
      const execution = preparedExecutionOrThrow(
        await prepareForCommand({
          projectDir,
          feature,
          effectiveConfig: config,
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
        'prose',
      );
      const sessionId = execution.session.ref.sessionId;
      const customRuntime = createCustomRunnerRuntime({
        projectDir,
        sessionId,
        sweepStaleReviews: true,
        onArtifactApproval: (_type: 'artifact', review: ArtifactApprovalReview) =>
          interaction === 'interactive'
            ? promptForArtifactApproval(review)
            : Promise.resolve({ approved: true as const }),
        admission: {
          interaction,
          allowRepoRunners: opts.allowRepoRunners,
          ...(interaction === 'interactive'
            ? { onTieredApproval: (request) => promptForDisclosure({ request }) }
            : {}),
        },
      });

      let planner: Planner;
      try {
        planner = await createPlannerForCommand(execution.config, {
          initialSessionId: undefined,
          projectDir,
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
      const driftWarning = compilerDriftWarning({ planner, projectDir });
      if (driftWarning !== null) warnStderr(driftWarning);

      console.log(
        `Planning feature: ${stripTerminalControls(feature)} (planner: ${getRunnerDisplayName(config.planner)}, mode: ${mode})\n`,
      );

      let result: PlanResult;
      try {
        result = await withCliErrors(() =>
          selectPlanCall(planner, mode).call(planner, {
            feature: execution.runtime.feature,
            projectDir,
            callbacks: {
              onOutput(text: string) {
                process.stdout.write(
                  sanitizeTerminalDisplayText(text, { preserveLineBreaks: true }),
                );
              },
              onPhase(phase: Phase) {
                console.log(`\n${ansis.bold(`--- ${phase} ---`)}\n`);
              },
              sessionId,
            },
          }),
        );
      } catch (cause) {
        rollbackPreparedExecutionOwnership(execution);
        throw cause;
      }
      releasePreparedExecutionOwnership(execution);

      for (const phase of result.phases ?? []) {
        writeSpecFile({ projectDir, sessionId }, phase.artifact.logicalName, phase.artifact.text);
      }

      const sessionPath = sessionDir(projectDir, sessionId);
      console.log('\nSpec generation complete.');
      console.log(`  Session: ${ansis.dim(sessionId)}`);
      for (const phase of result.phases ?? []) {
        const taskSuffix =
          phase.artifact.logicalName === TASKS_FILE ? ` (${result.tasks.length} tasks)` : '';
        console.log(`  ${ansis.dim(`${sessionPath}/${phase.artifact.logicalName}`)}${taskSuffix}`);
      }
    });
}

function selectPlanCall(
  planner: Planner,
  mode: WorkflowMode,
): (opts: PlanOptions) => Promise<PlanResult> {
  switch (mode) {
    case 'quick':
      return planner.quickPlan;
    case 'standard':
    case 'speckit':
      return planner.plan;
    default:
      return assertNever(mode);
  }
}
