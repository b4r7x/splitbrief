import type { Command } from 'commander';
import { plainUserMessage } from '../../core/types/user-input.js';
import chalk from 'chalk';
import { plainTheme } from '../../core/theme/resolve.js';
import { paint } from '../../core/theme/paint.js';
import { createPlanner } from '../../engine/runners/factory.js';
import type { Planner } from '../../engine/planners/types.js';
import { getRunnerDisplayName } from '../../core/config/accessors/runner-config.js';
import {
  assertGitRepo,
  ensureHeadlessConfig,
  canonicalizeProjectDir,
  loadConfigOrExit,
} from '../setup.js';
import { cliError, withCliErrors } from '../errors.js';
import { PLAN_FILE, PLAN_JSON_FILE, TASKS_FILE, sessionDir } from '../../core/paths.js';
import { writeSpecFile } from '../../core/paths-io.js';
import { ensureHooksTrusted } from '../hook-trust-prompt.js';
import { stripTerminalControls } from '../../utils/display-text.js';
import {
  PLAN_ANSWER_JSON_SCHEMA,
  PlanAnswerSchema,
  type PlanProposal,
} from '../../core/schemas/plan.js';
import { writePlanJson } from '../../core/sessions/plan-file.js';
import { requestTyped } from '../../engine/runners/typed-output.js';
import { formatTasks } from '../../engine/spec/formatter.js';
import { renderCheckNotes } from '../../engine/spec/plan-checks.js';
import { formatPlanMarkdown } from '../../engine/spec/plan-markdown.js';
import { taskFromSpec } from '../../engine/spec/plan-tasks.js';
import {
  MAX_QUESTION_ROUNDS,
  planFullTurn,
  type PlanRound,
} from '../../engine/spec/prompts/plan-session.js';
import {
  runPlanSession,
  type PlanSessionOutcome,
} from '../../engine/orchestrator/planning/plan-session.js';
import { checkFullPlan, planTurnText } from '../../engine/orchestrator/planning/session.js';
import { questionsText } from '../../core/state/planning-conversation.js';
import { modelCacheStore } from '../../stores/discovery/model-cache/state.js';
import {
  emitEffectiveConfigWarnings,
  resolveEffectiveConfig,
} from '../../core/config/runtime/effective-config.js';
import { workflowOptsToCLIOverrides } from '../../core/config/runtime/overrides/from-options.js';
import type { ArtifactApprovalReview } from '../../engine/runners/types.js';
import { createCustomRunnerRuntime } from '../../engine/runners/custom-runner-runtime.js';
import {
  promptCustomRunnerArtifactApproval,
  promptCustomRunnerDisclosure,
  promptForLine,
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
};

function sessionFailure(outcome: Exclude<PlanSessionOutcome, { kind: 'plan' }>): Error {
  switch (outcome.kind) {
    case 'seat-protocol':
      return outcome.error;
    case 'questions-exhausted':
      return cliError(
        `The planner asked a third round of questions; a session takes ${MAX_QUESTION_ROUNDS}.`,
      );
    case 'checks-failed':
      return cliError(
        `The plan failed its checks again after one repair:\n${outcome.errors
          .map((error) => `- ${error.message}`)
          .join('\n')}`,
      );
  }
}

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
    .description('Plan a feature and write its plan and Task Briefs (no implementation)')
    .option('--project <dir>', 'Project directory (default: cwd)')
    .option('--allow-hooks', 'Trust hook config without prompting (use in CI)', false)
    .option('--allow-repo-runners', ALLOW_REPO_RUNNERS_HELP, false)
    .action(async (feature: string, opts: SpecOpts) => {
      const projectDir = await canonicalizeProjectDir(opts);
      await assertGitRepo(projectDir);
      const initialInvocation = await ensureHeadlessConfig({
        projectDir,
        overrides: workflowOptsToCLIOverrides(opts),
      });

      clearStaleSessionForCli(projectDir);

      const loaded = loadConfigOrExit(projectDir);
      const theme = plainTheme();
      await ensureHooksTrusted({
        projectDir,
        hooks: loaded.config.hooks,
        allowHooks: opts.allowHooks,
      });
      const { config, warnings } = resolveEffectiveConfig({
        base: initialInvocation ?? loaded.config,
        ...(initialInvocation === undefined && { overrides: workflowOptsToCLIOverrides(opts) }),
        loaderDiagnostics: loaded.loaderDiagnostics,
      });
      emitEffectiveConfigWarnings(warnings);

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
      console.log(
        `Planning feature: ${stripTerminalControls(feature)} (planner: ${getRunnerDisplayName(config.planner)})\n`,
      );

      const ref = { projectDir, sessionId };
      let plan: PlanProposal;
      try {
        plan = await withCliErrors(async () => {
          // The BUILD context is measured as a headless `start` measures it.
          const planContext = { config: execution.config, projectDir, modelCache: modelCacheStore };
          const turnText = await planTurnText({
            wctx: { ...planContext, sessionId },
            planner,
            feature: execution.runtime.feature,
            language: undefined,
            onWarn: (message) => console.warn(stripTerminalControls(message)),
          });
          const rounds: PlanRound[] = [];
          let asked = '';
          const outcome = await runPlanSession({
            rounds: 0,
            ask: async (turn) => {
              if (turn.kind === 'answers')
                rounds.push({ reply: asked, answer: turn.reply.message.text });
              return requestTyped({
                prompt: await turnText((prompt) =>
                  planFullTurn(prompt, rounds, turn.kind === 'repair' ? turn : undefined),
                ),
                schema: PlanAnswerSchema,
                jsonSchema: PLAN_ANSWER_JSON_SCHEMA,
                schemaName: 'plan_result',
                call: planner.typedCall({
                  projectDir,
                  seat: 'planner',
                  callbacks: { onOutput: () => {} },
                }),
              });
            },
            // Without a terminal nobody can answer, so every question takes its default.
            answer: async (questions) => {
              asked = questionsText(questions);
              console.log(`${chalk.bold('The planner asks:')}\n${stripTerminalControls(asked)}\n`);
              return plainUserMessage(
                interaction === 'interactive'
                  ? await promptForLine('Your answer (⏎ takes the defaults): ')
                  : '',
              );
            },
            check: (proposal) => checkFullPlan(planContext, proposal),
          });
          if (outcome.kind !== 'plan') throw sessionFailure(outcome);
          return outcome.plan;
        });
      } catch (cause) {
        rollbackPreparedExecutionOwnership(execution);
        throw cause;
      }
      releasePreparedExecutionOwnership(execution);

      const tasks = plan.tasks.map((spec) => taskFromSpec(spec, projectDir));
      writePlanJson(ref, plan);
      writeSpecFile(
        ref,
        PLAN_FILE,
        formatPlanMarkdown(plan, renderCheckNotes(plan, execution.config.validation.render)),
      );
      writeSpecFile(ref, TASKS_FILE, formatTasks(tasks));

      const sessionPath = sessionDir(projectDir, sessionId);
      console.log('\nPlanning complete.');
      console.log(`  Session: ${paint(theme.textDim, sessionId)}`);
      console.log(`  ${paint(theme.textDim, `${sessionPath}/${PLAN_JSON_FILE}`)}`);
      console.log(`  ${paint(theme.textDim, `${sessionPath}/${PLAN_FILE}`)}`);
      console.log(
        `  ${paint(theme.textDim, `${sessionPath}/${TASKS_FILE}`)} (${tasks.length} tasks)`,
      );
    });
}
