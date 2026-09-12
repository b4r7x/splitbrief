import { randomUUID } from 'node:crypto';
import {
  withAutoRouteProfiles,
  withoutImplementerProfiles,
} from '../../../core/config/accessors/implementer-profiles.js';
import { applyRunnerPreparationChecks, collectReadiness } from '../../../core/readiness/collect.js';
import { exemptLiveSessionBlocker } from '../../../core/readiness/checks/repo.js';
import {
  aggregateReadinessStatus,
  countReadinessChecks,
  flattenReadinessChecks,
  selectNextAction,
} from '../../../core/readiness/status.js';
import type { ReadinessCheck, ReadinessReport } from '../../../core/readiness/types.js';
import { CLI_TOOL_CATALOG } from '../../../core/runners/cli-tool-catalog.js';
import type { Config } from '../../../core/schemas/config.js';
import type { WorkflowState } from '../../../core/schemas/workflow.js';
import type { SessionOwnershipReceipt } from '../../../core/sessions/active-pointer.js';
import { reactivateExistingSession } from '../../../core/sessions/active-pointer.js';
import { prepareNewSession } from '../../../core/sessions/prepare.js';
import type { SessionRef } from '../../../core/types/session-ref.js';
import { isAbortError, throwIfAborted } from '../../../utils/abort.js';
import { error, matches } from '../../../utils/error.js';
import { detectRunnerEvidence } from '../../detection/runner-evidence.js';
import { collectArgVectorPreflightChecks } from '../arg-vector-preflight.js';
import {
  CUSTOM_RUNNER_TRUST_PERSISTED_AFTER_ABORT,
  prepareCustomRunnerAdmission,
} from '../custom-admission.js';
import {
  parsePreparedConfig,
  type PreparationOutcome,
  type PreparedConfig,
  type PreparedExecutionSession,
  type PreparedReviewExecution,
  type RunnerGate,
} from '../prepared-execution.js';
import { probeRunnerAvailability, type RunnerAvailabilityRole } from '../probe-availability.js';
import { resolveCliExecutableAliases } from '../resolve-cli-executable.js';
import { checkRunnerTrust } from '../trust.js';
import { persistedTrustAbortError, throwIfPreparationAborted } from './abort-guard.js';
import {
  admitAutoRouteRows,
  autoRouteFallbackChecks,
  derivedAutoRouteProfiles,
  type EvaluatedSlot,
} from './auto-route-admission.js';
import { loadAutoRouteCandidates } from './auto-route-candidates.js';
import { evaluateCandidate } from './evaluate-candidate.js';
import { blockedCheck, runnerCandidates } from './runner-candidates.js';
import type {
  PreparationContext,
  PreparationPolicy,
  PrepareExecutionDependencies,
  SlotEvaluation,
} from './types.js';

type PrepareExecutionCommon = Readonly<{
  feature: string;
  effectiveConfig: Config;
  signal: AbortSignal;
  plannerContext?: string | undefined;
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
  policy: Extract<PreparationPolicy, { purpose: 'review' }>;
  signal: AbortSignal;
  deps?: Partial<PrepareExecutionDependencies> | undefined;
}>;

const DEFAULT_DEPENDENCIES: PrepareExecutionDependencies = {
  collectReadiness,
  collectArgVectorPreflightChecks,
  probeRunnerAvailability,
  detectRunnerEvidence,
  prepareCustomRunnerAdmission,
  resolveCliExecutableAliases,
  prepareNewSession,
  reactivateExistingSession,
  newPreparationId: randomUUID,
};

async function revalidateCliGates(
  gates: readonly RunnerGate[],
  context: PreparationContext,
): Promise<ReadinessCheck[]> {
  const blockers: ReadinessCheck[] = [];
  for (const gate of gates) {
    if (gate.kind !== 'cli') continue;
    try {
      await context.deps.resolveCliExecutableAliases({
        commands: CLI_TOOL_CATALOG[gate.tool].executableAliases,
        projectDir: context.projectDir,
        trust: gate.executable,
      });
      throwIfAborted(context.signal);
    } catch (cause) {
      if (context.signal.aborted || isAbortError(cause)) throw cause;
      blockers.push(
        blockedCheck(gate.slot, gate.kind, 'CLI executable identity changed after admission.'),
      );
    }
  }
  return blockers;
}

/**
 * A spec run never calls the implementer or the reviewer, so their reachability
 * cannot gate one; a one-shot review calls only the review seat.
 */
function availabilityRoles(
  purpose: PreparationPolicy['purpose'],
): readonly RunnerAvailabilityRole[] {
  switch (purpose) {
    case 'spec':
      return ['planner'];
    case 'review':
      return ['reviewer'];
    default:
      return ['planner', 'implementer', 'reviewer'];
  }
}

function exemptReadOnlyBlockers(report: ReadinessReport): ReadinessReport {
  const sections = report.sections.map((section) => ({
    ...section,
    checks: section.checks.map(exemptLiveSessionBlocker),
  }));
  const checks = flattenReadinessChecks(sections);
  const counts = countReadinessChecks(checks);
  const status = aggregateReadinessStatus(counts);
  return { ...report, sections, counts, status, nextAction: selectNextAction(checks, status) };
}

type AdmissionInput = Readonly<{
  projectDir: string;
  effectiveConfig: Config;
  policy: PreparationPolicy;
  signal: AbortSignal;
  deps?: Partial<PrepareExecutionDependencies> | undefined;
  resumeSession?: SessionRef | undefined;
}>;

type AdmittedRunners = Readonly<{
  config: PreparedConfig;
  preparationId: string;
  report: ReadinessReport;
  gates: readonly RunnerGate[];
  deps: PrepareExecutionDependencies;
  trustPersisted: boolean;
}>;

type AdmissionResult =
  | Readonly<{ kind: 'admitted'; admitted: AdmittedRunners }>
  | Readonly<{ kind: 'blocked'; report: ReadinessReport }>;

/** The last report the caller can attach to a failure, updated as it is refined. */
type ReportSink = { report?: ReadinessReport | undefined };

/**
 * Everything a workflow start and a one-shot review agree on: readiness, the
 * per-slot admission ladder, the gates it mints and their revalidation. What
 * happens afterwards — a session, or deliberately none — is the caller's.
 */
async function admitRunners(input: AdmissionInput, sink: ReportSink): Promise<AdmissionResult> {
  throwIfAborted(input.signal);
  // An `auto:cheapest` implementer seat is a policy, not a runner: the priced
  // rows it can be routed to become its profile table here, before admission
  // enumerates the slots, so every derived row is probed and gated like any
  // other profile and the router can reach it later.
  const autoRouteCandidates = await loadAutoRouteCandidates({
    projectDir: input.projectDir,
    config: input.effectiveConfig,
  });
  throwIfAborted(input.signal);
  const routed = withAutoRouteProfiles(input.effectiveConfig, autoRouteCandidates);
  const derived = derivedAutoRouteProfiles(input.effectiveConfig, routed);
  const routingChecks = autoRouteFallbackChecks(input.effectiveConfig, routed);
  const config = parsePreparedConfig(routed);
  const deps = { ...DEFAULT_DEPENDENCIES, ...input.deps };
  const preparationId = deps.newPreparationId();
  const collected = await deps.collectReadiness({
    projectDir: input.projectDir,
    config,
    cliReadiness: [],
    probeRunnerAvailability: (probe) =>
      deps.probeRunnerAvailability({
        ...probe,
        roles: availabilityRoles(input.policy.purpose),
        signal: input.signal,
      }),
    ...(input.resumeSession !== undefined && { resumeSession: input.resumeSession }),
  });
  throwIfAborted(input.signal);
  // collectReadiness is given no probe results, so it emits a placeholder
  // blocker per configured CLI. This function supersedes those with its own
  // per-candidate verdicts below, so they are stripped before the status is read.
  const rebuild = (checks: readonly ReadinessCheck[]): ReadinessReport => {
    const applied = applyRunnerPreparationChecks(collected.report, checks);
    return input.policy.purpose === 'review' ? exemptReadOnlyBlockers(applied) : applied;
  };
  let report = rebuild([]);
  sink.report = report;
  if (report.status === 'blocked') return { kind: 'blocked', report };

  const enumeration = runnerCandidates(config, input.policy.purpose);
  if (enumeration.checks.length > 0) {
    report = applyRunnerPreparationChecks(report, enumeration.checks);
    sink.report = report;
    return { kind: 'blocked', report };
  }

  const nativeTrustViolations = new Set(
    checkRunnerTrust(config, input.projectDir).violations.map((violation) => violation.label),
  );
  const context: PreparationContext = {
    projectDir: input.projectDir,
    config,
    policy: input.policy,
    preparationId,
    signal: input.signal,
    nativeTrustViolations,
    deps,
  };
  const evaluated: EvaluatedSlot[] = [];
  let trustPersisted = false;
  for (const candidate of enumeration.candidates) {
    let evaluation: SlotEvaluation;
    try {
      evaluation = await evaluateCandidate(candidate, context);
    } catch (cause) {
      if (input.signal.aborted && trustPersisted) throw persistedTrustAbortError();
      throw cause;
    }
    evaluated.push({ candidate, evaluation });
    if (evaluation.kind === 'admitted' && evaluation.trustPersisted === true) {
      trustPersisted = true;
    }
    throwIfPreparationAborted(input.signal, trustPersisted);
  }
  const routing = admitAutoRouteRows({ evaluated, derived });
  const slotChecks = [...routingChecks, ...routing.checks];
  report = applyRunnerPreparationChecks(report, slotChecks);
  sink.report = report;
  if (routing.kept.some((slot) => slot.evaluation.kind === 'blocked')) {
    return { kind: 'blocked', report };
  }
  const admittedConfig =
    routing.dropped.size === 0
      ? config
      : parsePreparedConfig(withoutImplementerProfiles(routed, routing.dropped));

  const gates = routing.kept.flatMap((slot) =>
    slot.evaluation.kind === 'admitted' ? [slot.evaluation.gate] : [],
  );
  let revalidationBlockers: ReadinessCheck[];
  try {
    revalidationBlockers = await revalidateCliGates(gates, context);
  } catch (cause) {
    if (input.signal.aborted && trustPersisted) throw persistedTrustAbortError();
    throw cause;
  }
  throwIfPreparationAborted(input.signal, trustPersisted);
  if (revalidationBlockers.length > 0) {
    const blockedIds = new Set(revalidationBlockers.map((check) => check.id));
    report = rebuild([
      ...slotChecks.filter((check) => !blockedIds.has(check.id)),
      ...revalidationBlockers,
    ]);
    sink.report = report;
    return { kind: 'blocked', report };
  }

  // The preflight runs a real binary, so it waits for the trust ladder above
  // to name one. It still lands before any planning is paid for.
  const argVectorChecks = await deps.collectArgVectorPreflightChecks({
    config: admittedConfig,
    projectDir: input.projectDir,
    roles: availabilityRoles(input.policy.purpose),
  });
  throwIfPreparationAborted(input.signal, trustPersisted);
  report = applyRunnerPreparationChecks(report, argVectorChecks);
  sink.report = report;
  if (report.status === 'blocked') return { kind: 'blocked', report };

  return {
    kind: 'admitted',
    admitted: { config: admittedConfig, preparationId, report, gates, deps, trustPersisted },
  };
}

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
        policy: input.policy,
        signal: input.signal,
        ...(input.deps !== undefined && { deps: input.deps }),
        ...(resume && { resumeSession: input.existingSession }),
      },
      sink,
    );
    if (admission.kind === 'blocked') return { kind: 'blocked', report: admission.report };
    const { config, preparationId, report, gates, deps, trustPersisted } = admission.admitted;

    let session: PreparedExecutionSession;
    if (resume) {
      throwIfPreparationAborted(input.signal, trustPersisted);
      const active = deps.reactivateExistingSession(input.existingSession);
      session = { kind: 'existing', ref: input.existingSession, active };
    } else {
      throwIfPreparationAborted(input.signal, trustPersisted);
      const preparedSession = deps.prepareNewSession({
        projectDir,
        feature: input.feature,
        config,
        report,
        signal: input.signal,
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
        preparationId,
        report,
        gates,
        session,
        runtime: {
          feature: input.feature,
          ...(input.plannerContext !== undefined && { plannerContext: input.plannerContext }),
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
        policy: input.policy,
        signal: input.signal,
        ...(input.deps !== undefined && { deps: input.deps }),
      },
      sink,
    );
    if (admission.kind === 'blocked') return { kind: 'blocked', report: admission.report };
    const { config, preparationId, report, gates } = admission.admitted;
    return {
      kind: 'prepared',
      execution: { purpose: 'review', config, preparationId, report, gates },
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
  const autoRouteCandidates = await loadAutoRouteCandidates({
    projectDir: input.projectDir,
    config: input.config,
  });
  const routed = withAutoRouteProfiles(input.config, autoRouteCandidates);
  const derived = derivedAutoRouteProfiles(input.config, routed);
  const config = parsePreparedConfig(routed);
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

  const nativeTrustViolations = new Set(
    checkRunnerTrust(config, input.projectDir).violations.map((violation) => violation.label),
  );
  const context: PreparationContext = {
    projectDir: input.projectDir,
    config,
    policy,
    preparationId,
    signal,
    nativeTrustViolations,
    deps,
  };
  const evaluated: EvaluatedSlot[] = [];
  for (const candidate of enumeration.candidates) {
    const evaluation = await evaluateCandidate(candidate, context);
    evaluated.push({ candidate, evaluation });
    throwIfAborted(signal);
  }
  return [
    ...autoRouteFallbackChecks(input.config, routed),
    ...admitAutoRouteRows({ evaluated, derived }).checks,
  ];
}
