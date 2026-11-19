import { randomUUID } from 'node:crypto';
import { updateNamedImplementerConfig } from '../../../core/config/accessors/implementer-profiles.js';
import { configuredReviewerRunner } from '../../../core/config/accessors/reviewer-runner.js';
import { variantWithoutModelChecks } from '../../../core/readiness/checks/runner/fields.js';
import { applyRunnerPreparationChecks, collectReadiness } from '../../../core/readiness/collect.js';
import { buildRunnerAdmissionChecks } from '../../../core/readiness/runner-causes.js';
import type { ReadinessReport, ReadinessCheck } from '../../../core/readiness/types.js';
import type { Config } from '../../../core/schemas/config.js';
import { createActiveSessionReceipt } from '../../../core/sessions/active-pointer.js';
import { prepareNewSession } from '../../../core/sessions/prepare.js';
import { throwIfAborted } from '../../../utils/abort.js';
import { resolveSeatDisplayName } from '../../providers/model/display-names.js';
import { resolveSeatImageFact } from '../../providers/model/resolution.js';
import { NULL_CACHE } from '../../providers/model/runtime-snapshot.js';
import { detectRunnerEvidence } from '../../detection/runner-evidence/detect.js';
import { collectArgVectorPreflightChecks } from '../arg-vector/preflight.js';
import { resolveCliExecutableAliases } from '../cli-executable/resolve.js';
import { prepareCustomRunnerAdmission } from '../custom/admission.js';
import { probeRunnerAvailability } from '../probe-availability.js';
import { createCliSeatGates } from '../seat-gates.js';
import { failAbortAfterSavedTrust, throwIfPreparationAborted } from './abort-guard.js';
import { evaluateCandidate } from './evaluate-candidate.js';
import { type PreparedConfig, type RunnerGate, parsePreparedConfig } from './prepared.js';
import {
  calledRoles,
  preparationContext,
  revalidateCliGates,
  installedVersionsOf,
  cliToolRecheck,
} from './recheck.js';
import { type RunnerCandidate, runnerCandidates } from './runner-candidates.js';
import type {
  PrepareExecutionDependencies,
  AdmissionInput,
  ReportSink,
  AdmissionResult,
  EvaluatedSlot,
  PreparationContext,
} from './types.js';

export const DEFAULT_DEPENDENCIES: PrepareExecutionDependencies = {
  collectReadiness,
  collectArgVectorPreflightChecks,
  probeRunnerAvailability,
  detectRunnerEvidence,
  prepareCustomRunnerAdmission,
  resolveCliExecutableAliases,
  prepareNewSession,
  createActiveSessionReceipt,
  newPreparationId: randomUUID,
};

/**
 * A seat left on `auto` runs with the model its tool had selected on this host,
 * named explicitly. The YAML and the config store keep the word `auto` — the
 * operator's intent — while the run's own record, its argv and every surface
 * downstream of preparation name the model that actually ran.
 */
function withEffectiveModels(config: PreparedConfig, gates: readonly RunnerGate[]): PreparedConfig {
  let next: Config = config;
  for (const gate of gates) {
    if (gate.kind !== 'cli' || gate.effectiveModel === undefined) continue;
    const model = gate.effectiveModel;
    if (gate.slot.role === 'planner') {
      next = { ...next, planner: { ...next.planner, model } };
    } else if (gate.slot.role === 'implementer') {
      const updated = updateNamedImplementerConfig(next, gate.slot.profile, (existing) => ({
        ...existing,
        model,
      }));
      if (updated !== null) next = updated;
    } else if (gate.slot.role === 'reviewer') {
      // With no reviewer block the planner holds the seat, and writing one here
      // would hand the run a second seat it was never configured with.
      const reviewer = configuredReviewerRunner(next);
      next =
        reviewer === undefined
          ? { ...next, planner: { ...next.planner, model } }
          : { ...next, reviewer: { ...reviewer, model } };
    }
  }
  return next === config ? config : parsePreparedConfig(next);
}

/** Runs the admission ladder for each candidate in order, and notes a saved trust. */
async function evaluateSlots(
  candidates: readonly RunnerCandidate[],
  context: PreparationContext,
): Promise<{ evaluated: EvaluatedSlot[]; trustPersisted: boolean }> {
  const evaluated: EvaluatedSlot[] = [];
  let trustPersisted = false;
  for (const candidate of candidates) {
    const evaluation = await failAbortAfterSavedTrust(context.signal, trustPersisted, () =>
      evaluateCandidate(candidate, context),
    );
    evaluated.push({ candidate, evaluation });
    if (evaluation.kind === 'admitted' && evaluation.trustPersisted === true) {
      trustPersisted = true;
    }
    throwIfPreparationAborted(context.signal, trustPersisted);
  }
  return { evaluated, trustPersisted };
}

/**
 * The verdict of each slot, then the variant rule of each admitted CLI seat. The
 * run's readiness reads no tool release and no host model, so the variant rule
 * waits for the gates that carry both.
 */
function slotAdmissionChecks(
  evaluated: readonly EvaluatedSlot[],
  reviewSettingsSeat: AdmissionInput['reviewSettingsSeat'],
): ReadinessCheck[] {
  return [
    ...buildRunnerAdmissionChecks(evaluated.map((slot) => slot.evaluation.check)),
    ...evaluated.flatMap(({ candidate, evaluation }) =>
      evaluation.kind === 'admitted' && evaluation.gate.kind === 'cli'
        ? variantWithoutModelChecks(
            candidate.slot.role === 'reviewer' && reviewSettingsSeat === 'planner'
              ? { role: 'planner' }
              : candidate.slot,
            candidate.runner,
            {
              installedVersion: evaluation.gate.installedVersion,
              model: evaluation.gate.effectiveModel ?? candidate.runner.model,
            },
          )
        : [],
    ),
  ];
}

/**
 * Everything a workflow start and a one-shot review agree on: readiness, the
 * per-slot admission ladder, the gates it mints and their revalidation. What
 * happens afterwards — a session, or deliberately none — is the caller's.
 */
export async function admitRunners(
  input: AdmissionInput,
  sink: ReportSink,
): Promise<AdmissionResult> {
  throwIfAborted(input.signal);
  const config = parsePreparedConfig(input.effectiveConfig);
  const deps = { ...DEFAULT_DEPENDENCIES, ...input.deps };
  const preparationId = deps.newPreparationId();
  const roles = calledRoles(input.policy.purpose);
  const collected = await deps.collectReadiness({
    projectDir: input.projectDir,
    config,
    configWarnings: input.configWarnings,
    interaction: input.policy.interaction,
    roles,
    cliReadiness: [],
    probeRunnerAvailability: (probe) =>
      deps.probeRunnerAvailability({ ...probe, roles, signal: input.signal }),
    ...(input.resumeSession !== undefined && { resumeSession: input.resumeSession }),
    seatDisplayName: (runner, role) =>
      resolveSeatDisplayName(runner, role, input.policy.modelCache ?? NULL_CACHE),
    seatImageFact: (runner, role) =>
      resolveSeatImageFact({ runner, role, cache: input.policy.modelCache ?? NULL_CACHE }),
    detectedContextLength: input.policy.getDetectedContextLength?.(),
  });
  throwIfAborted(input.signal);
  // collectReadiness is given no probe results, so it emits a placeholder
  // blocker per configured CLI. This function supersedes those with its own
  // per-candidate verdicts below, so they are stripped before the status is read.
  const rebuild = (checks: readonly ReadinessCheck[]): ReadinessReport =>
    applyRunnerPreparationChecks(collected.report, checks);
  let report = rebuild([]);
  sink.report = report;
  if (report.status === 'blocked') return { kind: 'blocked', report };

  const enumeration = runnerCandidates(config, input.policy.purpose);
  if (enumeration.checks.length > 0) {
    report = applyRunnerPreparationChecks(report, enumeration.checks);
    sink.report = report;
    return { kind: 'blocked', report };
  }

  const context = preparationContext({
    projectDir: input.projectDir,
    config,
    policy: input.policy,
    preparationId,
    signal: input.signal,
    routeCatalogs: new Map(),
    deps,
  });
  const { evaluated, trustPersisted } = await evaluateSlots(enumeration.candidates, context);
  const slotChecks = slotAdmissionChecks(evaluated, input.reviewSettingsSeat);
  report = applyRunnerPreparationChecks(report, slotChecks);
  sink.report = report;
  if (evaluated.some((slot) => slot.evaluation.kind === 'blocked')) {
    return { kind: 'blocked', report };
  }
  const gates = evaluated.flatMap((slot) =>
    slot.evaluation.kind === 'admitted' ? [slot.evaluation.gate] : [],
  );
  const admittedConfig = withEffectiveModels(config, gates);
  const revalidationBlockers = await failAbortAfterSavedTrust(input.signal, trustPersisted, () =>
    revalidateCliGates(gates, context),
  );
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
  const argVectorChecks = await failAbortAfterSavedTrust(input.signal, trustPersisted, () =>
    deps.collectArgVectorPreflightChecks({
      config: admittedConfig,
      projectDir: input.projectDir,
      roles,
      installedVersions: installedVersionsOf(gates),
      signal: input.signal,
    }),
  );
  throwIfPreparationAborted(input.signal, trustPersisted);
  report = applyRunnerPreparationChecks(report, argVectorChecks);
  sink.report = report;
  if (report.status === 'blocked') return { kind: 'blocked', report };

  const recheck = cliToolRecheck(input, {
    config: admittedConfig,
    sourceConfig: config,
    preparationId,
    deps,
  });
  return {
    kind: 'admitted',
    admitted: {
      config: admittedConfig,
      sourceConfig: config,
      preparationId,
      report,
      gates,
      cliSeats: createCliSeatGates({ gates, recheck }),
      deps,
      trustPersisted,
    },
  };
}
