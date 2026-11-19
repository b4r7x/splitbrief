import type { EffectiveConfigWarning } from '../../../core/config/runtime/effective-config.js';
import { buildRunnerAdmissionChecks } from '../../../core/readiness/runner-causes.js';
import type { ReadinessCheck } from '../../../core/readiness/types.js';
import type { AttachedInput } from '../../../core/schemas/attachment.js';
import type { Config } from '../../../core/schemas/config.js';
import type { WorkflowState } from '../../../core/schemas/workflow/state.js';
import type { SessionOwnershipReceipt } from '../../../core/sessions/active-pointer.js';
import type { SessionRef } from '../../../core/types/session-ref.js';
import { isAbortError, throwIfAborted } from '../../../utils/abort.js';
import { matches, error } from '../../../utils/error.js';
import type { RouteCatalogReads } from '../../detection/route-catalog.js';
import { CUSTOM_RUNNER_TRUST_PERSISTED_AFTER_ABORT } from '../custom/admission.js';
import { throwIfPreparationAborted, persistedTrustAbortError } from './abort-guard.js';
import { admitRunners, DEFAULT_DEPENDENCIES } from './admission.js';
import { evaluateCandidate } from './evaluate-candidate.js';
import {
  type PreparationOutcome,
  type PreparedExecutionSession,
  type PreparedReviewExecution,
  parsePreparedConfig,
} from './prepared.js';
import { preparationContext } from './recheck.js';
import { runnerCandidates } from './runner-candidates.js';
import type {
  PrepareExecutionDependencies,
  PreparationPolicy,
  ReportSink,
  EvaluatedSlot,
} from './types.js';

type PrepareExecutionCommon = Readonly<{
  feature: string;
  effectiveConfig: Config;
  configWarnings: readonly EffectiveConfigWarning[];
  signal: AbortSignal;
  plannerContext?: string | undefined;
  attachedInputs?: readonly AttachedInput[] | undefined;
  resumeState?: WorkflowState | undefined;
  worktreeName?: string | undefined;
  deps?: Partial<PrepareExecutionDependencies> | undefined;
}>;

type NewPrepareExecutionInput = PrepareExecutionCommon &
  Readonly<{
    projectDir: string;
    policy: Extract<PreparationPolicy, { purpose: 'new-workflow' | 'spec' }>;
    existingSession?: never;
    candidate?: SessionOwnershipReceipt | undefined;
  }>;

type ResumePrepareExecutionInput = PrepareExecutionCommon &
  Readonly<{
    policy: Extract<PreparationPolicy, { purpose: 'resume' }>;
    existingSession: SessionRef;
    projectDir?: never;
    candidate?: never;
  }>;

export type PrepareExecutionInput = NewPrepareExecutionInput | ResumePrepareExecutionInput;

export type PrepareReviewExecutionInput = Readonly<{
  projectDir: string;
  effectiveConfig: Config;
  configWarnings: readonly EffectiveConfigWarning[];
  policy: Extract<PreparationPolicy, { purpose: 'review' }>;
  signal: AbortSignal;
  /** The seat whose settings the review seat holds: PLAN's for a REVIEW that follows PLAN. */
  reviewSettingsSeat: 'planner' | 'reviewer';
  deps?: Partial<PrepareExecutionDependencies> | undefined;
}>;

function preparationFailure(
  cause: unknown,
  signal: AbortSignal,
  sink: ReportSink,
): Extract<PreparationOutcome<never>, { kind: 'failed' | 'aborted' }> {
  if (matches(CUSTOM_RUNNER_TRUST_PERSISTED_AFTER_ABORT)(cause)) {
    return {
      kind: 'failed',
      ...(sink.report !== undefined && { report: sink.report }),
      error: cause,
    };
  }
  if (signal.aborted || isAbortError(cause)) return { kind: 'aborted' };
  return {
    kind: 'failed',
    ...(sink.report !== undefined && { report: sink.report }),
    error:
      cause instanceof Error
        ? cause
        : error('runner-preparation-failed', 'Runner preparation failed.'),
  };
}

export async function prepareExecution(input: PrepareExecutionInput): Promise<PreparationOutcome> {
  const sink: ReportSink = {};
  try {
    const resume = 'existingSession' in input;
    const projectDir = resume ? input.existingSession.projectDir : input.projectDir;
    const admission = await admitRunners(
      {
        projectDir,
        effectiveConfig: input.effectiveConfig,
        configWarnings: input.configWarnings,
        policy: input.policy,
        signal: input.signal,
        ...(input.deps !== undefined && { deps: input.deps }),
        ...(resume && { resumeSession: input.existingSession }),
      },
      sink,
    );
    if (admission.kind === 'blocked') return { kind: 'blocked', report: admission.report };
    const { config, sourceConfig, preparationId, report, gates, cliSeats, deps, trustPersisted } =
      admission.admitted;

    let session: PreparedExecutionSession;
    if (resume) {
      throwIfPreparationAborted(input.signal, trustPersisted);
      const active = deps.createActiveSessionReceipt(input.existingSession);
      session = { kind: 'existing', ref: input.existingSession, active };
    } else {
      throwIfPreparationAborted(input.signal, trustPersisted);
      const preparedSession = deps.prepareNewSession({
        projectDir,
        feature: input.feature,
        config,
        report,
        signal: input.signal,
        publishDefault: input.policy.purpose !== 'spec',
        ...(input.candidate !== undefined && { candidate: input.candidate }),
      });
      if (preparedSession.kind === 'aborted') {
        if (trustPersisted) throw persistedTrustAbortError();
        return { kind: 'aborted' };
      }
      session = { kind: 'new', ...preparedSession.session };
    }

    return {
      kind: 'prepared',
      execution: {
        purpose: input.policy.purpose,
        config,
        sourceConfig,
        preparationId,
        report,
        gates,
        cliSeats,
        session,
        runtime: {
          feature: input.feature,
          ...(input.plannerContext !== undefined && { plannerContext: input.plannerContext }),
          ...(input.attachedInputs !== undefined && { attachedInputs: input.attachedInputs }),
          ...(input.resumeState !== undefined && { resumeState: input.resumeState }),
          allowRepoRunners: input.policy.allowRepoRunners,
          allowHooks: input.policy.allowHooks,
          ...(input.worktreeName !== undefined && { worktreeName: input.worktreeName }),
        },
      },
    };
  } catch (cause) {
    return preparationFailure(cause, input.signal, sink);
  }
}

/**
 * The read-only seat, prepared on its own: only the reviewer is admitted, a run
 * in progress elsewhere is reported rather than refused, and no session is
 * minted — a one-shot review owns nothing to release, roll back or resume.
 */
export async function prepareReviewExecution(
  input: PrepareReviewExecutionInput,
): Promise<PreparationOutcome<PreparedReviewExecution>> {
  const sink: ReportSink = {};
  try {
    const admission = await admitRunners(
      {
        projectDir: input.projectDir,
        effectiveConfig: input.effectiveConfig,
        configWarnings: input.configWarnings,
        policy: input.policy,
        signal: input.signal,
        reviewSettingsSeat: input.reviewSettingsSeat,
        ...(input.deps !== undefined && { deps: input.deps }),
      },
      sink,
    );
    if (admission.kind === 'blocked') return { kind: 'blocked', report: admission.report };
    const { config, preparationId, report, gates, cliSeats } = admission.admitted;
    return {
      kind: 'prepared',
      execution: { purpose: 'review', config, preparationId, report, gates, cliSeats },
    };
  } catch (cause) {
    return preparationFailure(cause, input.signal, sink);
  }
}

export type RunnerAdmissionPreflightInput = Readonly<{
  projectDir: string;
  config: Config;
  /** The interaction a run started the same way would have. */
  interaction: 'interactive' | 'headless';
  purpose?: PreparationPolicy['purpose'] | undefined;
  signal?: AbortSignal | undefined;
  deps?: Partial<PrepareExecutionDependencies> | undefined;
  /** The model lists an earlier pass over the same seats read, so this pass reads none again. */
  routeCatalogs: RouteCatalogReads;
}>;

/**
 * `doctor` prepares nothing, so it used to pass CLI readiness and consent while
 * a headless `start` was still refused at admission. This replays
 * `prepareExecution`'s per-slot admission verdicts read-only — no session, no
 * trust receipt, no arg-vector preflight — so the two commands answer the same
 * question about the same machine.
 */
export async function collectRunnerAdmissionChecks(
  input: RunnerAdmissionPreflightInput,
): Promise<readonly ReadinessCheck[]> {
  const signal = input.signal ?? new AbortController().signal;
  throwIfAborted(signal);
  const config = parsePreparedConfig(input.config);
  const deps = { ...DEFAULT_DEPENDENCIES, ...input.deps };
  const preparationId = deps.newPreparationId();
  const policy: PreparationPolicy = {
    purpose: input.purpose ?? 'new-workflow',
    interaction: input.interaction,
    unverifiedAuth: input.interaction === 'headless' ? 'denied' : 'disclosed',
    allowRepoRunners: false,
    allowHooks: true,
  };
  const enumeration = runnerCandidates(config, policy.purpose);
  if (enumeration.checks.length > 0) return enumeration.checks;

  const context = preparationContext({
    projectDir: input.projectDir,
    config,
    policy,
    preparationId,
    signal,
    routeCatalogs: input.routeCatalogs,
    deps,
  });
  const evaluated: EvaluatedSlot[] = [];
  for (const candidate of enumeration.candidates) {
    const evaluation = await evaluateCandidate(candidate, context);
    evaluated.push({ candidate, evaluation });
    throwIfAborted(signal);
  }
  return buildRunnerAdmissionChecks(evaluated.map((slot) => slot.evaluation.check));
}
