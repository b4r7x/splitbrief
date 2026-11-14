import { assertNever } from '../../../../utils/type-guards.js';
import type { resolveImplementerProfiles } from '../../../config/accessors/implementer-profiles.js';
import { requireReviewSeat } from '../../../config/accessors/reviewer-runner.js';
import { formatSlotLabel } from '../../../crew/identity.js';
import type { Config } from '../../../schemas/config.js';
import type { ReadinessCheck, SeatNamer } from '../../types.js';
import { type RunnerAvailabilityFact, runnerAvailabilityCheck } from '../availability.js';

export function availabilityCheck(): ReadinessCheck {
  return {
    id: 'runners.availability',
    severity: 'info',
    summary: 'Provider availability was not probed.',
    details: [
      'CLI installation, trust, compatibility, and authentication use the selected runner readiness results.',
      'Readiness makes no provider or network availability claim.',
    ],
  };
}

export function buildAvailabilityChecks({
  config,
  profiles,
  facts,
  nameSeat,
}: {
  config: Config;
  profiles: ReturnType<typeof resolveImplementerProfiles>['profiles'];
  facts: readonly RunnerAvailabilityFact[];
  nameSeat: SeatNamer;
}): ReadinessCheck[] {
  return facts.map((fact) => {
    switch (fact.slot.role) {
      case 'planner':
        return runnerAvailabilityCheck({
          fact,
          label: `${formatSlotLabel(fact.slot)} ${nameSeat(config.planner, 'planner')}`,
          isDefaultImplementer: false,
        });
      case 'reviewer':
        return runnerAvailabilityCheck({
          fact,
          label: `${formatSlotLabel(fact.slot)} ${nameSeat(requireReviewSeat(config).runner, 'reviewer')}`,
          isDefaultImplementer: false,
        });
      case 'implementer': {
        const profileName = fact.slot.profile;
        const profile = profiles.find((candidate) => candidate.name === profileName);
        const runner = profile === undefined ? '' : ` ${nameSeat(profile.config, 'implementer')}`;
        return runnerAvailabilityCheck({
          fact,
          label: `${formatSlotLabel(fact.slot)}${runner}`,
          isDefaultImplementer: profile?.isDefault === true,
        });
      }
      default:
        return assertNever(fact.slot);
    }
  });
}
