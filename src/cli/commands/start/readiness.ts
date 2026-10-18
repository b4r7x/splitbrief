import { resolveImplementerProfiles } from '../../../core/config/accessors/implementer-profiles.js';
import { runnerRoleForSlot, runnerSlotId } from '../../../core/config/accessors/runner-config.js';
import type {
  CliRouteInputs,
  RememberedToolCatalog,
} from '../../../core/readiness/checks/cli-readiness.js';
import type { Config } from '../../../core/schemas/config.js';
import type { AttachedInput } from '../../../core/schemas/attachment.js';
import type { CliReadinessResult } from '../../../core/schemas/readiness.js';
import type { ImplementerConfig } from '../../../core/schemas/implementer-config.js';
import type { PlannerConfig } from '../../../core/schemas/planner-config.js';
import { resolveReviewerRunner } from '../../../core/config/accessors/reviewer-runner.js';
import { routeAuthState } from '../../../core/runners/route-auth.js';
import {
  CLI_TOOL_IDS,
  type CliAuthChannelId,
  type CliToolId,
} from '../../../core/runners/cli-tool-catalog.js';
import type { ReadinessReport } from '../../../core/readiness/types.js';
import {
  formatReadinessBlockers,
  readinessBlockerPointer,
} from '../../../core/readiness/format.js';
import { assertNoLiveSession, clearStaleSession } from '../../../core/sessions/guards.js';
import { sessionError } from '../../../core/sessions/errors.js';
import { detectAvailableCliReadiness } from '../../../engine/detection/detect.js';
import {
  loadRememberedSnapshot,
  type RememberedCliCatalog,
} from '../../../engine/detection/cache.js';
import { cliSeatDiscoveryContext } from '../../../engine/detection/cli-context.js';
import {
  freshRouteCatalog,
  routeReadsCatalog,
  savedRouteCatalog,
  type RouteCatalogReads,
} from '../../../engine/detection/route-catalog.js';
import { detectRunnerEvidence } from '../../../engine/detection/runner-evidence.js';
import { resolveSeatModel } from '../../../engine/runners/host-model-selection.js';
import {
  runnerCandidates,
  type RunnerCandidate,
} from '../../../engine/runners/prepare-execution/runner-candidates.js';
import { prepareExecution } from '../../../engine/runners/prepare-execution/prepare-execution.js';
import type { PreparationPolicy } from '../../../engine/runners/prepare-execution/types.js';
import type {
  PreparationOutcome,
  PreparedExecution,
} from '../../../engine/runners/prepared-execution.js';
import { rollbackPreparedExecutionOwnership } from '../../../engine/runners/prepared-execution.js';
import { resolveCliRunnerAuth } from '../../../engine/runners/sandbox-env.js';
import type { CustomRunnerAdmissionPolicy } from '../../../engine/runners/types.js';
import { toErrorMessage } from '../../../utils/format-errors.js';
import type { WorkflowOpts } from '../../../core/types/config-options.js';
import { resolveRunConfig } from '../../build-overrides.js';
import { modelCacheStore } from '../../../stores/discovery/model-cache/state.js';
import { cliError } from '../../errors.js';
import { promptCustomRunnerDisclosure } from '../../custom-runner-prompts.js';

export type DetectCliReadiness = (input: {
  projectDir: string;
  config: Config;
  opts: WorkflowOpts;
}) => Promise<readonly CliReadinessResult[]>;

function configuredCliAuthChannels(
  config: Config,
): Partial<Record<CliToolId, CliAuthChannelId | undefined>> {
  const selections = new Map<CliToolId, CliAuthChannelId | undefined>();
  const add = (runner: Extract<PlannerConfig | ImplementerConfig, { kind: 'cli' }>): void => {
    const channel = resolveCliRunnerAuth(runner).id;
    if (!selections.has(runner.tool)) {
      selections.set(runner.tool, channel);
      return;
    }
    if (selections.get(runner.tool) !== channel) selections.set(runner.tool, undefined);
  };

  if (config.planner.kind === 'cli') add(config.planner);
  const reviewer = resolveReviewerRunner(config);
  if (reviewer.source === 'configured' && reviewer.runner.kind === 'cli') add(reviewer.runner);
  try {
    for (const profile of resolveImplementerProfiles(config).profiles) {
      if (profile.config.kind === 'cli') add(profile.config);
    }
  } catch {
    // Config readiness reports the invalid profile, so doctor does not guess a context here.
  }

  return Object.fromEntries(selections);
}

export const detectConfiguredCliReadiness: DetectCliReadiness = async ({ projectDir, config }) => {
  const authChannels = configuredCliAuthChannels(config);
  const tools = CLI_TOOL_IDS.filter((tool) => Object.hasOwn(authChannels, tool));
  if (tools.length === 0) return [];
  return detectAvailableCliReadiness({ projectDir, tools, authChannels });
};

/**
 * What doctor and a headless first run read each CLI seat's route against, the way start reads it:
 * the model the seat calls, and the tool's model list. The list is read fresh only when no saved
 * list counts for the route (`savedRouteCatalog`), the seat's route waits on it, and the tool is
 * ready or refused only on sign-in; `routeCatalogs` holds those reads, so a later pass over the
 * same seats reads no list again. A tool read fresh is read against that read alone: it names the
 * project, so it serves every route of the tool a saved list serves.
 */
export async function readConfiguredCliRoutes(
  input: Readonly<{
    projectDir: string;
    config: Config;
    cliReadiness: readonly Pick<CliReadinessResult, 'tool' | 'status' | 'providerAuth'>[];
    routeCatalogs: RouteCatalogReads;
  }>,
): Promise<CliRouteInputs> {
  const { projectDir, config } = input;
  const snapshot = await loadRememberedSnapshot(projectDir);
  const saved: RememberedCliCatalog[] = [];
  const seatModels = new Map<string, string | undefined>();
  let candidates: readonly RunnerCandidate[];
  try {
    candidates = runnerCandidates(config, 'new-workflow').candidates;
  } catch {
    // Runner readiness reports the invalid profile; every route then reads its configured model.
    return {
      seatModels,
      catalogs: (snapshot?.cliCatalogs ?? []).flatMap(
        ({ tool }) => savedRouteCatalog(snapshot, tool, undefined) ?? [],
      ),
    };
  }
  for (const { slot, runner } of candidates) {
    if (runner.kind !== 'cli') continue;
    const seatModel = await resolveSeatModel(
      runner,
      process.env,
      savedRouteCatalog(snapshot, runner.tool, runner.model)?.models,
    );
    const catalog = savedRouteCatalog(snapshot, runner.tool, seatModel.model);
    if (catalog !== undefined && !saved.includes(catalog)) saved.push(catalog);
    seatModels.set(runnerSlotId(slot), seatModel.model);
    const readiness = input.cliReadiness.find((result) => result.tool === runner.tool);
    if (
      (readiness?.status === 'ready' || readiness?.status === 'unauthenticated') &&
      routeReadsCatalog(
        routeAuthState({
          tool: runner.tool,
          model: seatModel.model,
          providerAuth: readiness.providerAuth,
          catalog,
        }),
      )
    ) {
      await freshRouteCatalog(input.routeCatalogs, runner.tool, () =>
        detectRunnerEvidence({
          context: cliSeatDiscoveryContext({ role: runnerRoleForSlot(slot), runner, config }),
          projectDir,
          includeCatalog: true,
          catalogNamesProject: true,
        }),
      );
    }
  }
  const catalogs: RememberedToolCatalog[] = saved.filter(
    (catalog) => !input.routeCatalogs.has(catalog.tool),
  );
  for (const [tool, read] of input.routeCatalogs) {
    const catalog = await read;
    if (catalog !== undefined) catalogs.push({ tool, ...catalog });
  }
  return { seatModels, catalogs };
}

// A live session is left in place: preparation readiness reports it as the
// `repo.active-session-live` blocker with its remediation.
export function clearStaleSessionForCli(projectDir: string): void {
  try {
    clearStaleSession(projectDir);
  } catch (err) {
    if (sessionError.isStillActive(err)) return;
    throw err;
  }
}

// For surfaces that only open the TUI (home, setup): refuse to run alongside a
// live session, but never touch the active pointer — deleting it would break
// `splitbrief resume` for the stale-but-resumable case.
export function assertNoLiveSessionForCli(projectDir: string): void {
  try {
    assertNoLiveSession(projectDir);
  } catch (err) {
    if (sessionError.isStillActive(err)) throw cliError(err.message, 1);
    throw err;
  }
}

/**
 * The stdout contract, not the terminal, decides whether the blocker report is
 * printed: withholding it on every headless run left `spec` telling the reader
 * to resolve blockers it had not printed.
 */
export function preparedExecutionOrThrow<Execution = PreparedExecution>(
  outcome: PreparationOutcome<Execution>,
  stdout: 'prose' | 'structured',
): Execution {
  switch (outcome.kind) {
    case 'prepared':
      return outcome.execution;
    case 'blocked':
      if (stdout === 'prose') console.log(formatReadinessBlockers(outcome.report));
      throw cliError(readinessBlockerPointer(outcome.report), 1);
    case 'failed':
      throw cliError(toErrorMessage(outcome.error), 1);
    case 'aborted':
      throw cliError('Runner preparation was cancelled.', 1);
  }
}

type CliPreparationPolicyInput = Readonly<{
  purpose: PreparationPolicy['purpose'];
  interaction: 'interactive' | 'headless';
  opts: WorkflowOpts;
  onTieredApproval?: CustomRunnerAdmissionPolicy['onTieredApproval'];
}>;

export function cliPreparationPolicy(
  input: CliPreparationPolicyInput & Readonly<{ purpose: 'resume' }>,
): Extract<PreparationPolicy, { purpose: 'resume' }>;
export function cliPreparationPolicy(
  input: CliPreparationPolicyInput & Readonly<{ purpose: 'new-workflow' | 'spec' }>,
): Extract<PreparationPolicy, { purpose: 'new-workflow' | 'spec' }>;
export function cliPreparationPolicy(
  input: CliPreparationPolicyInput & Readonly<{ purpose: 'review' }>,
): Extract<PreparationPolicy, { purpose: 'review' }>;
export function cliPreparationPolicy(input: CliPreparationPolicyInput): PreparationPolicy {
  return {
    purpose: input.purpose,
    interaction: input.interaction,
    allowRepoRunners: input.opts.allowRepoRunners ?? false,
    allowHooks: input.opts.allowHooks ?? false,
    unverifiedAuth:
      input.interaction === 'interactive'
        ? 'disclosed'
        : input.opts.allowUnverifiedAuth === true
          ? 'allowed'
          : 'denied',
    modelCache: modelCacheStore,
    ...(input.interaction === 'interactive' && {
      onTieredApproval:
        input.onTieredApproval ?? ((request) => promptCustomRunnerDisclosure({ request })),
    }),
  };
}

type StartPreparationInput = Readonly<{
  projectDir: string;
  feature: string;
  plannerContext?: string | undefined;
  attachedInputs?: readonly AttachedInput[] | undefined;
  opts: WorkflowOpts;
  effectiveConfig?: Config | undefined;
  transport: 'interactive' | 'headless';
  emitReadiness: (report: ReadinessReport) => void;
  /** Where an interactive start asks for runner trust; without one it asks on the terminal. */
  onTieredApproval?: CustomRunnerAdmissionPolicy['onTieredApproval'];
  prepare?: typeof prepareExecution | undefined;
  signal?: AbortSignal | undefined;
}>;

/**
 * The outcome of a start preparation, before any of it reaches the terminal. An interactive start
 * hands this to the shared preparation coordinator, which decides whether the attempt still owns
 * the screen when it settles.
 */
export async function prepareStartOutcome(
  input: StartPreparationInput,
): Promise<PreparationOutcome> {
  const config =
    input.effectiveConfig ??
    resolveRunConfig({
      projectDir: input.projectDir,
      opts: input.opts,
    });
  clearStaleSessionForCli(input.projectDir);
  const interaction = input.transport;
  const outcome = await (input.prepare ?? prepareExecution)({
    projectDir: input.projectDir,
    feature: input.feature,
    effectiveConfig: config,
    policy: cliPreparationPolicy({
      purpose: 'new-workflow',
      interaction,
      opts: input.opts,
      ...(input.onTieredApproval !== undefined && { onTieredApproval: input.onTieredApproval }),
    }),
    signal: input.signal ?? new AbortController().signal,
    ...(input.plannerContext !== undefined && { plannerContext: input.plannerContext }),
    ...(input.attachedInputs !== undefined && { attachedInputs: input.attachedInputs }),
  });
  if (outcome.kind !== 'aborted') {
    const report = outcome.kind === 'prepared' ? outcome.execution.report : outcome.report;
    if (report !== undefined) {
      try {
        input.emitReadiness(report);
      } catch (cause) {
        if (outcome.kind === 'prepared') rollbackPreparedExecutionOwnership(outcome.execution);
        throw cause;
      }
    }
  }
  return outcome;
}

export async function prepareStartExecution(
  input: StartPreparationInput,
): Promise<PreparedExecution> {
  return preparedExecutionOrThrow(
    await prepareStartOutcome(input),
    input.transport === 'interactive' ? 'prose' : 'structured',
  );
}
