import { isAutoCheapestModel } from '../../../core/providers/automatic-model.js';
import type { ReadinessCheck } from '../../../core/readiness/types.js';
import type { Config } from '../../../core/schemas/config.js';
import type { RunnerCandidate } from './runner-candidates.js';
import type { SlotEvaluation } from './types.js';

export type EvaluatedSlot = Readonly<{
  candidate: RunnerCandidate;
  evaluation: SlotEvaluation;
}>;

type AutoRouteAdmission = Readonly<{
  /** Derived rows the run gives up rather than block on. */
  dropped: ReadonlySet<string>;
  /** The slots whose verdict still governs the preparation. */
  kept: readonly EvaluatedSlot[];
  /** One check per evaluated slot, each dropped row downgraded to a warning. */
  checks: readonly ReadinessCheck[];
}>;

/**
 * The profile names price routing invented for this preparation: a table the
 * config already declared is the operator's own and is never derived, so only a
 * seat that had no table can have derived rows.
 */
export function derivedAutoRouteProfiles(before: Config, routed: Config): ReadonlySet<string> {
  if (before.implementerProfiles !== undefined || routed.implementerProfiles === undefined) {
    return new Set();
  }
  return new Set(Object.keys(routed.implementerProfiles.profiles));
}

function profileNameOf(candidate: RunnerCandidate): string | undefined {
  return candidate.slot.role === 'implementer' ? candidate.slot.profile : undefined;
}

function derivedProfileOf(slot: EvaluatedSlot, derived: ReadonlySet<string>): string | undefined {
  const profile = profileNameOf(slot.candidate);
  return profile !== undefined && derived.has(profile) ? profile : undefined;
}

function droppedRowCheck(profile: string, blocked: ReadinessCheck): ReadinessCheck {
  return {
    ...blocked,
    severity: 'warning',
    summary: `Implementer profile ${profile} was dropped from price routing.`,
    fix: 'Refresh detection for that tool to route to its price again.',
    nextAction: 'prepare-runner',
  };
}

/**
 * A derived auto-route row is one price the seat could be routed to, not a
 * runner the operator picked: a tool that logged out since the last readiness
 * pass must cost the run that row, not the whole preparation. So a blocked
 * derived row is dropped — its blocker downgraded to a warning that still
 * carries the tool's own remediation — as long as another derived row was
 * admitted. When none survives, every blocker stands.
 */
export function admitAutoRouteRows(
  input: Readonly<{ evaluated: readonly EvaluatedSlot[]; derived: ReadonlySet<string> }>,
): AutoRouteAdmission {
  const { evaluated, derived } = input;
  const derivedSlots = evaluated.filter((slot) => derivedProfileOf(slot, derived) !== undefined);
  const anyAdmitted = derivedSlots.some((slot) => slot.evaluation.kind === 'admitted');
  const dropped = new Set<string>(
    !anyAdmitted
      ? []
      : derivedSlots.flatMap((slot) => {
          if (slot.evaluation.kind !== 'blocked') return [];
          const profile = derivedProfileOf(slot, derived);
          return profile === undefined ? [] : [profile];
        }),
  );

  const kept: EvaluatedSlot[] = [];
  const checks: ReadinessCheck[] = [];
  for (const slot of evaluated) {
    const profile = profileNameOf(slot.candidate);
    if (profile !== undefined && dropped.has(profile)) {
      checks.push(droppedRowCheck(profile, slot.evaluation.check));
      continue;
    }
    kept.push(slot);
    checks.push(slot.evaluation.check);
  }

  return { dropped, kept, checks };
}

/**
 * A cold or stale detection record prices nothing, so the seat keeps the marker
 * and the implementer runs on whatever model its tool defaults to — usually the
 * most expensive one it offers. That is a spending decision, so it is a warning
 * on the readiness report rather than silence.
 */
export function autoRouteFallbackChecks(before: Config, routed: Config): readonly ReadinessCheck[] {
  if (!isAutoCheapestModel(before.implementer.model)) return [];
  if (routed.implementerProfiles !== undefined) return [];
  return [
    {
      id: 'runners.preparation.implementer.auto-cheapest',
      severity: 'warning',
      summary: 'Price routing found no priced row, so the implementer keeps its own default model.',
      details: [
        'No recent detection pass priced a ready CLI tool, so "auto:cheapest" resolves to no model and the tool chooses one itself.',
      ],
      fix: 'Refresh detection (open the runner picker or run `splitbrief doctor`), then retry.',
      nextAction: 'prepare-runner',
      metadata: { role: 'implementer', kind: before.implementer.kind },
    },
  ];
}
