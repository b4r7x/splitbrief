import { resolveImplementerProfiles } from '../../../core/config/accessors/implementer-profiles.js';
import type { Config } from '../../../core/schemas/config.js';
import type { CliReadinessResult } from '../../../core/schemas/readiness.js';
import type { ImplementerConfig } from '../../../core/schemas/implementer-config.js';
import type { PlannerConfig } from '../../../core/schemas/planner-config.js';
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
  prepareExecution,
  type PreparationPolicy,
} from '../../../engine/runners/prepare-execution.js';
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
import { cliError } from '../../errors.js';
import { promptCustomRunnerDisclosure } from '../../custom-runner-prompts.js';
import { assertHeadlessTaskReviewDisabled } from '../../headless.js';

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
export function preparedExecutionOrThrow(
  outcome: PreparationOutcome,
  stdout: 'prose' | 'structured',
): PreparedExecution {
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
    ...(input.interaction === 'interactive' && {
      onTieredApproval:
        input.onTieredApproval ?? ((request) => promptCustomRunnerDisclosure({ request })),
    }),
  };
}

export async function prepareStartExecution(
  input: Readonly<{
    projectDir: string;
    feature: string;
    plannerContext?: string | undefined;
    worktreeName?: string | undefined;
    opts: WorkflowOpts;
    transport: 'interactive' | 'json' | 'rpc';
    defaultApprove?: 'none' | undefined;
    emitReadiness: (report: ReadinessReport) => void;
    prepare?: typeof prepareExecution | undefined;
    /**
     * Interactive starts mount the TUI before preparation resolves. Ink owns the
     * alternate screen buffer and erases it on exit, so every outcome that prints
     * a blocker report or throws hands the terminal back through this hook first.
     */
    releaseTerminal?: (() => Promise<void>) | undefined;
  }>,
): Promise<PreparedExecution> {
  const config = resolveRunConfig({
    projectDir: input.projectDir,
    opts: input.opts,
    ...(input.defaultApprove !== undefined && { defaultApprove: input.defaultApprove }),
  });
  if (input.transport === 'json') assertHeadlessTaskReviewDisabled(config);
  clearStaleSessionForCli(input.projectDir);
  const interaction = input.transport === 'interactive' ? 'interactive' : 'headless';
  const outcome = await (input.prepare ?? prepareExecution)({
    projectDir: input.projectDir,
    feature: input.feature,
    effectiveConfig: config,
    policy: cliPreparationPolicy({
      purpose: 'new-workflow',
      interaction,
      opts: input.opts,
    }),
    signal: new AbortController().signal,
    ...(input.plannerContext !== undefined && { plannerContext: input.plannerContext }),
    ...(input.worktreeName !== undefined && { worktreeName: input.worktreeName }),
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
  if (outcome.kind !== 'prepared') await input.releaseTerminal?.();
  return preparedExecutionOrThrow(
    outcome,
    input.transport === 'interactive' ? 'prose' : 'structured',
  );
}
