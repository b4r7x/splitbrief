import {
  resolveRunnerConfigContext,
  type RunnerConfig,
  type RunnerConfigSlot,
} from '../../../core/config/accessors/runner-config.js';
import { resolveImplementerProfiles } from '../../../core/config/accessors/implementer-profiles.js';
import { resolveIntermediateRunner } from '../../../core/config/accessors/intermediate-runner.js';
import { resolveReviewerRunner } from '../../../core/config/accessors/reviewer-runner.js';
import type { ReadinessCheck } from '../../../core/readiness/types.js';
import type { Config } from '../../../core/schemas/config.js';
import { assertNever } from '../../../utils/type-guards.js';
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

function slotId(slot: RunnerConfigSlot): string {
  switch (slot.role) {
    case 'planner':
      return 'planner';
    case 'implementer':
      return `implementer.${slot.profile}`;
    case 'intermediate':
      return 'intermediate';
    case 'reviewer':
      return 'reviewer';
    default:
      return assertNever(slot);
  }
}

function slotLabel(slot: RunnerConfigSlot): string {
  switch (slot.role) {
    case 'planner':
      return 'Planner';
    case 'implementer':
      return `Implementer profile ${slot.profile}`;
    case 'intermediate':
      return 'Intermediate runner';
    case 'reviewer':
      return 'Reviewer';
    default:
      return assertNever(slot);
  }
}

export function admittedCheck(slot: RunnerConfigSlot, kind: RunnerConfig['kind']): ReadinessCheck {
  return {
    id: `runners.preparation.${slotId(slot)}`,
    severity: 'ok',
    summary: `${slotLabel(slot)} passed fresh runner admission.`,
    metadata: { role: slot.role, kind },
  };
}

export function blockedCheck(
  slot: RunnerConfigSlot,
  kind: RunnerConfig['kind'],
  reason: string,
  fix = 'Review the configured runner, then retry.',
): ReadinessCheck {
  return {
    id: `runners.preparation.${slotId(slot)}`,
    severity: 'blocker',
    summary: `${slotLabel(slot)} could not be admitted.`,
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
  // implementer or an unresolvable escalation provider cannot gate it. The seat
  // itself is whatever `resolveReviewerRunner` decides — the configured block,
  // or the planner holding the seat.
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

  if (
    config.escalation?.enabled !== false &&
    config.escalation?.intermediateProvider !== undefined
  ) {
    const resolved = resolveIntermediateRunner(config);
    if (resolved === null) {
      return {
        candidates,
        checks: [
          {
            id: 'runners.preparation.intermediate',
            severity: 'blocker',
            summary: 'Intermediate runner could not be resolved.',
            fix: 'Fix escalation.intermediateProvider and intermediateModel, then retry.',
            nextAction: 'fix-config',
            metadata: { role: 'intermediate', kind: 'api' },
          },
        ],
      };
    }
    const context = resolveRunnerConfigContext({ role: 'intermediate', runner: resolved.runner });
    candidates.push({ slot: context.slot, runner: resolved.runner, trustLabel: 'intermediate' });
  }

  const reviewer = resolveReviewerRunner(config);
  if (reviewer.source === 'configured') {
    const context = resolveRunnerConfigContext({ role: 'reviewer', runner: reviewer.runner });
    candidates.push({ slot: context.slot, runner: reviewer.runner, trustLabel: 'reviewer' });
  }

  return { candidates, checks: [] };
}
