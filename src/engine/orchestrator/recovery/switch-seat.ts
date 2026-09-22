import type { Config } from '../../../core/schemas/config.js';
import {
  ImplementerConfigSchema,
  type ImplementerConfig,
} from '../../../core/schemas/implementer-config.js';
import {
  updateDefaultImplementerConfig,
  updateNamedImplementerConfig,
} from '../../../core/config/accessors/implementer-profiles.js';
import { PlannerConfigSchema } from '../../../core/schemas/planner-config.js';
import { ReviewerConfigSchema } from '../../../core/schemas/reviewer-config.js';
import type { SeatSwapCandidate } from '../../../core/schemas/recovery/schemas.js';
import type { CrewSeatId } from '../../../core/crew/identity.js';
import { assertNever } from '../../../utils/type-guards.js';

/**
 * The build seat is routed out of the implementer profile table whenever the
 * config carries one, so repointing `config.implementer` alone would leave the
 * run on the tool that hit its limit: the profile that failed is repointed at
 * the chosen tool instead, or the table's default entry when the halt named no
 * profile.
 */
function configWithSwitchedBuildSeat(
  config: Config,
  implementer: ImplementerConfig,
  implementerProfile: string | undefined,
): Config | null {
  return implementerProfile === undefined
    ? updateDefaultImplementerConfig(config, () => implementer)
    : updateNamedImplementerConfig(config, implementerProfile, () => implementer);
}

/**
 * The config a quota-blocked seat resumes on: the same run config with that
 * one seat pointed at the chosen tool. The candidate is validated through the
 * seat's own schema, so a tool id the seat cannot host is rejected here rather
 * than at the runner factory. `implementerProfile` names the build profile
 * that failed; a name the profile table does not carry is rejected too.
 *
 * The runner itself is rebuilt by the caller — `createPlanner` /
 * `createImplementer` / `createReviewer` all demand the preparation authority
 * receipt that recovery, a synchronous state transition, never holds.
 */
export function configWithSwitchedSeat(
  config: Config,
  seat: CrewSeatId,
  candidate: SeatSwapCandidate,
  implementerProfile?: string | undefined,
): Config | null {
  const runner = {
    kind: 'cli',
    tool: candidate.tool,
    ...(candidate.model !== undefined && { model: candidate.model }),
    ...(candidate.effort !== undefined && { effort: candidate.effort }),
    ...(candidate.variant !== undefined && { variant: candidate.variant }),
  };
  switch (seat) {
    case 'plan': {
      const parsed = PlannerConfigSchema.safeParse(runner);
      return parsed.success ? { ...config, planner: parsed.data } : null;
    }
    case 'build': {
      const parsed = ImplementerConfigSchema.safeParse(runner);
      return parsed.success
        ? configWithSwitchedBuildSeat(config, parsed.data, implementerProfile)
        : null;
    }
    case 'review': {
      const parsed = ReviewerConfigSchema.safeParse(runner);
      return parsed.success ? { ...config, reviewer: parsed.data } : null;
    }
    default:
      return assertNever(seat);
  }
}
