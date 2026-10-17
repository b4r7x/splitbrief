import {
  resolveRunnerConfigContext,
  runnerSlotId,
  type RunnerConfig,
  type RunnerConfigSlot,
} from '../../../core/config/accessors/runner-config.js';
import { resolveImplementerProfiles } from '../../../core/config/accessors/implementer-profiles.js';
import { resolveReviewerRunner } from '../../../core/config/accessors/reviewer-runner.js';
import { formatSlotLabel } from '../../../core/crew/identity.js';
import type { ReadinessCheck } from '../../../core/readiness/types.js';
import type { Config } from '../../../core/schemas/config.js';
import type { PreparationPolicy } from './types.js';

export type RunnerCandidate = Readonly<{
  slot: RunnerConfigSlot;
  runner: RunnerConfig;
  trustLabel: string;
}>;

export type CandidateEnumeration = Readonly<{
  candidates: readonly RunnerCandidate[];
  checks: readonly ReadinessCheck[];
}>;

export function admittedCheck(
  slot: RunnerConfigSlot,
  kind: RunnerConfig['kind'],
  details: readonly string[] = [],
): ReadinessCheck {
  return {
    id: `runners.preparation.${runnerSlotId(slot)}`,
    severity: 'ok',
    summary: `${formatSlotLabel(slot)} is ready to start.`,
    ...(details.length > 0 && { details: [...details] }),
    metadata: { role: slot.role, kind },
  };
}

/** A seat that starts, with something about the start the operator should know. */
export type PreparationWarning = Readonly<{ code: string; message: string }>;

export function warningCheck(
  slot: RunnerConfigSlot,
  kind: RunnerConfig['kind'],
  warnings: readonly PreparationWarning[],
  details: readonly string[] = [],
): ReadinessCheck {
  return {
    id: `runners.preparation.${runnerSlotId(slot)}`,
    severity: 'warning',
    summary: `${formatSlotLabel(slot)} is ready with warnings.`,
    details: [...warnings.map((warning) => warning.message), ...details],
    metadata: { role: slot.role, kind, warnings: warnings.map((warning) => warning.code) },
  };
}

export function blockedCheck(
  slot: RunnerConfigSlot,
  kind: RunnerConfig['kind'],
  reason: string,
  fix = 'Review the configured runner, then retry.',
): ReadinessCheck {
  return {
    id: `runners.preparation.${runnerSlotId(slot)}`,
    severity: 'blocker',
    summary: `${formatSlotLabel(slot)} could not start.`,
    details: [reason],
    fix,
    nextAction: 'fix-config',
    metadata: { role: slot.role, kind },
  };
}

export function runnerCandidates(
  config: Config,
  purpose: PreparationPolicy['purpose'],
): CandidateEnumeration {
  // A one-shot review calls the review seat and nothing else, so a missing
  // implementer cannot gate it. The seat itself is whatever `resolveReviewerRunner`
  // decides — the configured block, or the planner holding the seat.
  if (purpose === 'review') {
    const runner = resolveReviewerRunner(config).runner;
    const context = resolveRunnerConfigContext({ role: 'reviewer', runner });
    return {
      candidates: [{ slot: context.slot, runner, trustLabel: 'reviewer' }],
      checks: [],
    };
  }

  const plannerContext = resolveRunnerConfigContext({ role: 'planner', runner: config.planner });
  const candidates: RunnerCandidate[] = [
    { slot: plannerContext.slot, runner: config.planner, trustLabel: 'planner' },
  ];
  if (purpose === 'spec') return { candidates, checks: [] };

  for (const profile of resolveImplementerProfiles(config).profiles) {
    const context = resolveRunnerConfigContext({
      role: 'implementer',
      profile: profile.name,
      runner: profile.config,
    });
    candidates.push({
      slot: context.slot,
      runner: profile.config,
      trustLabel:
        config.implementerProfiles?.profiles[profile.name] === undefined
          ? 'implementer'
          : `implementer profile ${profile.name}`,
    });
  }

  const reviewer = resolveReviewerRunner(config);
  if (reviewer.source === 'configured') {
    const context = resolveRunnerConfigContext({ role: 'reviewer', runner: reviewer.runner });
    candidates.push({ slot: context.slot, runner: reviewer.runner, trustLabel: 'reviewer' });
  }

  return { candidates, checks: [] };
}
