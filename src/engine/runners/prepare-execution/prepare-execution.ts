import { randomUUID } from 'node:crypto';
import { applyRunnerPreparationChecks, collectReadiness } from '../../../core/readiness/collect.js';
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
  type PreparedExecutionSession,
  type RunnerGate,
} from '../prepared-execution.js';
import { probeRunnerAvailability, type RunnerAvailabilityRole } from '../probe-availability.js';
import { resolveCliExecutableAliases } from '../resolve-cli-executable.js';
import { checkRunnerTrust } from '../trust.js';
import { persistedTrustAbortError, throwIfPreparationAborted } from './abort-guard.js';
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

/** A spec run never calls the implementer or the reviewer, so their reachability cannot gate one. */
function availabilityRoles(
  purpose: PreparationPolicy['purpose'],
): readonly RunnerAvailabilityRole[] {
  return purpose === 'spec' ? ['planner'] : ['planner', 'implementer', 'reviewer'];
}

export async function prepareExecution(input: PrepareExecutionInput): Promise<PreparationOutcome> {
  let report: ReadinessReport | undefined;
  try {
    throwIfAborted(input.signal);
    const resume = 'existingSession' in input;
    const projectDir = resume ? input.existingSession.projectDir : input.projectDir;
    const config = parsePreparedConfig(input.effectiveConfig);
    const deps = { ...DEFAULT_DEPENDENCIES, ...input.deps };
    const preparationId = deps.newPreparationId();
    const collected = await deps.collectReadiness({
      projectDir,
      config,
      cliReadiness: [],
      probeRunnerAvailability: (probe) =>
        deps.probeRunnerAvailability({
          ...probe,
          roles: availabilityRoles(input.policy.purpose),
          signal: input.signal,
        }),
      ...(resume && { resumeSession: input.existingSession }),
    });
    throwIfAborted(input.signal);
    // collectReadiness is given no probe results, so it emits a placeholder
    // blocker per configured CLI. This function supersedes those with its own
    // per-candidate verdicts below, so they are stripped before the status is read.
    report = applyRunnerPreparationChecks(collected.report, []);
    if (report.status === 'blocked') return { kind: 'blocked', report };

    const enumeration = runnerCandidates(config, input.policy.purpose);
    if (enumeration.checks.length > 0) {
      report = applyRunnerPreparationChecks(report, enumeration.checks);
      return { kind: 'blocked', report };
    }

    const nativeTrustViolations = new Set(
      checkRunnerTrust(config, projectDir).violations.map((violation) => violation.label),
    );
    const context: PreparationContext = {
      projectDir,
      config,
      policy: input.policy,
      preparationId,
      signal: input.signal,
      nativeTrustViolations,
      deps,
    };
    const evaluations: SlotEvaluation[] = [];
    let trustPersisted = false;
    for (const candidate of enumeration.candidates) {
      let evaluation: SlotEvaluation;
      try {
        evaluation = await evaluateCandidate(candidate, context);
      } catch (cause) {
        if (input.signal.aborted && trustPersisted) throw persistedTrustAbortError();
        throw cause;
      }
      evaluations.push(evaluation);
      if (evaluation.kind === 'admitted' && evaluation.trustPersisted === true) {
        trustPersisted = true;
      }
      throwIfPreparationAborted(input.signal, trustPersisted);
    }
    report = applyRunnerPreparationChecks(
      report,
      evaluations.map((evaluation) => evaluation.check),
    );
    if (evaluations.some((evaluation) => evaluation.kind === 'blocked')) {
      return { kind: 'blocked', report };
    }

    const gates = evaluations.flatMap((evaluation) =>
      evaluation.kind === 'admitted' ? [evaluation.gate] : [],
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
      report = applyRunnerPreparationChecks(collected.report, [
        ...evaluations
          .map((evaluation) => evaluation.check)
          .filter((check) => !blockedIds.has(check.id)),
        ...revalidationBlockers,
      ]);
      return { kind: 'blocked', report };
    }

    // The preflight runs a real binary, so it waits for the trust ladder above
    // to name one. It still lands before any planning is paid for.
    const argVectorChecks = await deps.collectArgVectorPreflightChecks({
      config,
      projectDir,
      roles: availabilityRoles(input.policy.purpose),
    });
    throwIfPreparationAborted(input.signal, trustPersisted);
    report = applyRunnerPreparationChecks(report, argVectorChecks);
    if (report.status === 'blocked') return { kind: 'blocked', report };

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
    if (matches(CUSTOM_RUNNER_TRUST_PERSISTED_AFTER_ABORT)(cause)) {
      return {
        kind: 'failed',
        ...(report !== undefined && { report }),
        error: cause,
      };
    }
    if (input.signal.aborted || isAbortError(cause)) return { kind: 'aborted' };
    return {
      kind: 'failed',
      ...(report !== undefined && { report }),
      error:
        cause instanceof Error
          ? cause
          : error('runner-preparation-failed', 'Runner preparation failed.'),
    };
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
  const checks: ReadinessCheck[] = [];
  for (const candidate of enumeration.candidates) {
    const evaluation = await evaluateCandidate(candidate, context);
    checks.push(evaluation.check);
    throwIfAborted(signal);
  }
  return checks;
}
