import type { Command } from 'commander';
import { plainUserMessage } from '../../core/types/user-input.js';
import chalk from 'chalk';
import { plainTheme } from '../../core/theme/resolve.js';
import { paint } from '../../core/theme/paint.js';
import { createPlanner } from '../../engine/runners/factory.js';
import type { Planner } from '../../engine/planners/types.js';
import { getRunnerCatalogDisplayName } from '../../core/config/accessors/runner-config.js';
import {
  assertGitRepo,
  ensureHeadlessConfig,
  canonicalizeProjectDir,
  loadConfigOrExit,
} from '../setup.js';
import { cliError, withCliErrors } from '../errors.js';
import { PLAN_FILE, PLAN_JSON_FILE, TASKS_FILE, sessionDir } from '../../core/paths.js';
import { writeSpecFile } from '../../core/sessions/spec-files.js';
import { ensureHooksTrusted } from '../hook-trust-prompt.js';
import { oneLineDisplayText, stripTerminalControls } from '../../utils/display-text/sanitize.js';
import {
  PLAN_ANSWER_JSON_SCHEMA,
  PlanAnswerSchema,
  type PlanProposal,
} from '../../core/schemas/plan.js';
import { writePlanJson } from '../../core/sessions/plan-file.js';
import { requestTyped } from '../../engine/runners/typed-output.js';
import { formatTasks } from '../../engine/spec/formatter.js';
import { renderCheckNotes } from '../../engine/spec/plan/render-checks.js';
import { formatPlanMarkdown } from '../../engine/spec/plan/markdown.js';
import { taskFromSpec } from '../../engine/spec/plan/tasks.js';
import {
  MAX_QUESTION_ROUNDS,
  planFullTurn,
  type PlanRound,
} from '../../engine/spec/prompts/plan-session.js';
import { runCommandSeatCall } from '../../engine/orchestrator/escalation/seat/call.js';
import {
  runPlanSession,
  type PlanSessionOutcome,
} from '../../engine/orchestrator/planning/plan-session.js';
import { checkFullPlan } from '../../engine/orchestrator/planning/compile.js';
import { planTurnText } from '../../engine/orchestrator/planning/turn-text.js';
import { questionsText } from '../../core/state/planning-conversation.js';
import { modelCacheStore } from '../../stores/discovery/model-cache/state.js';
import { loadRememberedCatalog } from '../bootstrap/discovery.js';
import { resolveSpecMetadata } from '../../engine/providers/model/display-names.js';
import { resolveEffectiveConfig } from '../../core/config/runtime/effective-config.js';
import { workflowOptsToCLIOverrides } from '../../core/config/runtime/overrides/from-options.js';
import type { ArtifactApprovalReview } from '../../engine/runners/types.js';
import { createCustomRunnerRuntime } from '../../engine/runners/custom/runtime.js';
import {
  promptCustomRunnerArtifactApproval,
  promptCustomRunnerDisclosure,
  promptForLine,
} from '../custom-runner-prompts.js';
import { ALLOW_REPO_RUNNERS_HELP } from '../options/workflow.js';
import { prepareExecution } from '../../engine/runners/prepare-execution/prepare.js';
import {
  releasePreparedExecutionOwnership,
  rollbackPreparedExecutionOwnership,
  type PreparedExecution,
} from '../../engine/runners/prepare-execution/prepared.js';
import type { Config } from '../../core/schemas/config.js';
import { clearStaleSessionForCli } from '../sessions/resolve.js';
import { cliPreparationPolicy, preparedExecutionOrThrow } from '../preparation.js';

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

type SpecDeps = { [K in keyof SpecCommandDeps]-?: NonNullable<SpecCommandDeps[K]> };

/** A spec after preparation: the session it owns and who is there to answer the planner. */
type PreparedSpec = Readonly<{
  projectDir: string;
  sessionId: string;
  config: Config;
  interaction: 'interactive' | 'headless';
  execution: PreparedExecution;
}>;

async function prepareSpec(feature: string, opts: SpecOpts, deps: SpecDeps): Promise<PreparedSpec> {
  const projectDir = await canonicalizeProjectDir(opts);
  await assertGitRepo(projectDir);
  const initialInvocation = await ensureHeadlessConfig({
    projectDir,
    overrides: workflowOptsToCLIOverrides(opts),
  });

  clearStaleSessionForCli(projectDir);

  const loaded = loadConfigOrExit(projectDir);
  await ensureHooksTrusted({
    projectDir,
    hooks: loaded.config.hooks,
    allowHooks: opts.allowHooks,
  });
  const { config, warnings } = resolveEffectiveConfig({
    base: initialInvocation?.config ?? loaded.config,
    ...(initialInvocation === undefined && { overrides: workflowOptsToCLIOverrides(opts) }),
    loaderDiagnostics: loaded.loaderDiagnostics,
  });
  await loadRememberedCatalog(projectDir);

  const interaction = process.stdin.isTTY ? 'interactive' : 'headless';
  const execution = preparedExecutionOrThrow(
    await deps.prepareExecution({
      projectDir,
      feature,
      effectiveConfig: config,
      configWarnings: warnings,
      policy: cliPreparationPolicy({
        purpose: 'spec',
        interaction,
        opts,
        ...(interaction === 'interactive' && {
          onTieredApproval: (request) => deps.promptCustomRunnerDisclosure({ request }),
        }),
      }),
      signal: new AbortController().signal,
    }),
    'prose',
    'planner',
  );
  return { projectDir, sessionId: execution.session.ref.sessionId, config, interaction, execution };
}

async function createSpecPlanner(
  spec: PreparedSpec,
  opts: SpecOpts,
  deps: SpecDeps,
): Promise<Planner> {
  const { projectDir, interaction, execution } = spec;
  const customRuntime = createCustomRunnerRuntime({
    projectDir,
    sessionId: spec.sessionId,
    sweepStaleReviews: true,
    onArtifactApproval: (_type: 'artifact', review: ArtifactApprovalReview) =>
      interaction === 'interactive'
        ? deps.promptCustomRunnerArtifactApproval(review)
        : Promise.resolve({ approved: true as const }),
    admission: {
      interaction,
      allowRepoRunners: opts.allowRepoRunners,
      ...(interaction === 'interactive'
        ? { onTieredApproval: (request) => deps.promptCustomRunnerDisclosure({ request }) }
        : {}),
    },
  });

  try {
    return await deps.createPlanner(execution.config, {
      initialSessionId: undefined,
      projectDir,
      preparedConfig: execution.config,
      customRuntime,
      preparationId: execution.preparationId,
      gates: execution.gates,
      cliSeats: execution.cliSeats,
      slot: { role: 'planner' },
    });
  } catch (cause) {
    rollbackPreparedExecutionOwnership(execution);
    throw cause;
  }
}

async function runSpecPlanSession(spec: PreparedSpec, planner: Planner): Promise<PlanProposal> {
  const { projectDir, sessionId, config, interaction, execution } = spec;
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
          const prompt = await turnText((prompt) =>
            planFullTurn(prompt, rounds, turn.kind === 'repair' ? turn : undefined),
          );
          return runCommandSeatCall(
            {
              tool: getRunnerCatalogDisplayName(config.planner),
              write: (line) => console.log(line),
            },
            (signal) =>
              requestTyped({
                prompt,
                schema: PlanAnswerSchema,
                jsonSchema: PLAN_ANSWER_JSON_SCHEMA,
                schemaName: 'plan_result',
                call: planner.typedCall({
                  projectDir,
                  seat: 'planner',
                  callbacks: { onOutput: () => {}, signal },
                }),
              }),
          );
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
  return plan;
}

function writeSpecArtifacts(
  { projectDir, sessionId, execution }: PreparedSpec,
  plan: PlanProposal,
): number {
  const ref = { projectDir, sessionId };
  const tasks = plan.tasks.map((spec) => taskFromSpec(spec, projectDir));
  const metadata = resolveSpecMetadata(execution.config, modelCacheStore);
  writePlanJson(ref, plan);
  writeSpecFile(
    ref,
    PLAN_FILE,
    formatPlanMarkdown(plan, renderCheckNotes(plan, execution.config, modelCacheStore)),
    metadata,
  );
  writeSpecFile(ref, TASKS_FILE, formatTasks(tasks), metadata);
  return tasks.length;
}

function printSpecResult(projectDir: string, sessionId: string, taskCount: number): void {
  const theme = plainTheme();
  const sessionPath = sessionDir(projectDir, sessionId);
  console.log('\nPlanning complete.');
  console.log(`  Session: ${paint(theme.textDim, sessionId)}`);
  console.log(`  ${paint(theme.textDim, `${sessionPath}/${PLAN_JSON_FILE}`)}`);
  console.log(`  ${paint(theme.textDim, `${sessionPath}/${PLAN_FILE}`)}`);
  console.log(`  ${paint(theme.textDim, `${sessionPath}/${TASKS_FILE}`)} (${taskCount} tasks)`);
}

async function runSpec(feature: string, opts: SpecOpts, deps: SpecDeps): Promise<void> {
  const spec = await prepareSpec(feature, opts, deps);
  const planner = await createSpecPlanner(spec, opts, deps);
  console.log(
    `Planning feature: ${oneLineDisplayText(feature)} (planner: ${getRunnerCatalogDisplayName(spec.config.planner)})\n`,
  );
  const plan = await runSpecPlanSession(spec, planner);
  const taskCount = writeSpecArtifacts(spec, plan);
  printSpecResult(spec.projectDir, spec.sessionId, taskCount);
}

export function registerSpecCommand(program: Command, deps: SpecCommandDeps = {}): void {
  const resolved: SpecDeps = {
    createPlanner: deps.createPlanner ?? createPlanner,
    prepareExecution: deps.prepareExecution ?? prepareExecution,
    promptCustomRunnerDisclosure: deps.promptCustomRunnerDisclosure ?? promptCustomRunnerDisclosure,
    promptCustomRunnerArtifactApproval:
      deps.promptCustomRunnerArtifactApproval ?? promptCustomRunnerArtifactApproval,
  };
  program
    .command('spec <feature>')
    .description('Plan a feature and write its plan and Task Briefs (no implementation)')
    .option('--project <dir>', 'Project directory (default: cwd)')
    .option('--allow-hooks', 'Trust hook config without prompting (use in CI)', false)
    .option('--allow-repo-runners', ALLOW_REPO_RUNNERS_HELP, false)
    .action((feature: string, opts: SpecOpts) => runSpec(feature, opts, resolved));
}
