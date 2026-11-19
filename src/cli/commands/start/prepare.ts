import type { EffectiveConfigResult } from '../../../core/config/runtime/effective-config.js';
import type { ReadinessReport } from '../../../core/readiness/types.js';
import type { AttachedInput } from '../../../core/schemas/attachment.js';
import type { WorkflowOpts } from '../../../core/types/config-options.js';
import { prepareExecution } from '../../../engine/runners/prepare-execution/prepare.js';
import {
  type PreparationOutcome,
  rollbackPreparedExecutionOwnership,
  type PreparedExecution,
} from '../../../engine/runners/prepare-execution/prepared.js';
import type { CustomRunnerAdmissionPolicy } from '../../../engine/runners/types.js';
import { resolveRunConfig } from '../../build-overrides.js';
import { cliPreparationPolicy, preparedExecutionOrThrow } from '../../preparation.js';

type StartPreparationInput = Readonly<{
  projectDir: string;
  feature: string;
  plannerContext?: string | undefined;
  attachedInputs?: readonly AttachedInput[] | undefined;
  opts: WorkflowOpts;
  effectiveConfig?: EffectiveConfigResult | undefined;
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
  const { config, warnings } =
    input.effectiveConfig ??
    resolveRunConfig({
      projectDir: input.projectDir,
      opts: input.opts,
    });
  const interaction = input.transport;
  const outcome = await (input.prepare ?? prepareExecution)({
    projectDir: input.projectDir,
    feature: input.feature,
    effectiveConfig: config,
    configWarnings: warnings,
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
