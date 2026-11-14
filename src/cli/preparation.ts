import {
  notAppliedWarnings,
  formatReadinessBlockers,
  readinessBlockerPointer,
} from '../core/readiness/format.js';
import type { ReadinessReport } from '../core/readiness/types.js';
import type { WorkflowOpts } from '../core/types/config-options.js';
import type { PreparationPolicy } from '../engine/runners/prepare-execution/types.js';
import type {
  PreparedExecution,
  PreparationOutcome,
} from '../engine/runners/prepare-execution/prepared.js';
import type { CustomRunnerAdmissionPolicy } from '../engine/runners/types.js';
import { warnStderr } from '../lib/warn.js';
import { modelCacheStore } from '../stores/discovery/model-cache/state.js';
import { toErrorMessage } from '../utils/format/errors.js';
import { promptCustomRunnerDisclosure } from './custom-runner-prompts.js';
import { cliError } from './errors.js';

/**
 * The thrown pointer tells the reader to resolve the blockers above it, so the report is always
 * printed first. The stdout contract decides where: a `'structured'` stdout (`--json`, `--plain`)
 * stays machine-readable, so its report goes to stderr. A command that starts no run names the
 * `seat` it calls, and its stderr states the flags and settings that seat does not apply.
 */
export function preparedExecutionOrThrow<
  Execution extends Readonly<{ report: ReadinessReport }> = PreparedExecution,
>(
  outcome: PreparationOutcome<Execution>,
  stdout: 'prose' | 'structured',
  seat?: 'planner' | 'reviewer' | undefined,
): Execution {
  switch (outcome.kind) {
    case 'prepared':
      if (seat !== undefined) {
        for (const line of notAppliedWarnings(outcome.execution.report, seat).flat()) {
          warnStderr(line, 'feedback');
        }
      }
      return outcome.execution;
    case 'blocked':
      if (stdout === 'prose') console.log(formatReadinessBlockers(outcome.report));
      else process.stderr.write(`${formatReadinessBlockers(outcome.report)}\n`);
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
