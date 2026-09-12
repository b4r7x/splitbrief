import type { Config } from '../../../core/schemas/config.js';
import {
  ImplementerConfigSchema,
  type ImplementerConfig,
} from '../../../core/schemas/implementer-config.js';
import { isAutoCheapestModel } from '../../../core/providers/automatic-model.js';
import { updateDefaultImplementerConfig } from '../../../core/config/accessors/implementer-profiles.js';
import { PlannerConfigSchema } from '../../../core/schemas/planner-config.js';
import { ReviewerConfigSchema } from '../../../core/schemas/reviewer-config.js';
import type { SeatSwapCandidate } from '../../../core/schemas/recovery/schemas.js';
import type { CrewSeatId } from '../../../core/crew/identity.js';
import { assertNever } from '../../../utils/type-guards.js';

/**
 * The build seat is routed out of the implementer profile table whenever the
 * config carries one, so repointing `config.implementer` alone would leave the
 * run on the tool that hit its limit. A table `auto:cheapest` derived at the
 * preparation boundary is an artifact of the routing policy this swap replaces,
 * so it goes and the switched seat stands alone; a table the config declared is
 * kept with its default entry repointed at the chosen tool.
 */
function configWithSwitchedBuildSeat(config: Config, implementer: ImplementerConfig): Config {
  if (config.implementerProfiles !== undefined && isAutoCheapestModel(config.implementer.model)) {
    const { implementerProfiles: _derived, ...rest } = config;
    return { ...rest, implementer };
  }
  return updateDefaultImplementerConfig(config, () => implementer);
}

/**
 * The config a quota-blocked seat resumes on: the same run config with that
 * one seat pointed at the chosen tool. The candidate is validated through the
 * seat's own schema, so a tool id the seat cannot host is rejected here rather
 * than at the runner factory.
 *
 * The runner itself is rebuilt by the caller — `createPlanner` /
 * `createImplementer` / `createReviewer` all demand the preparation authority
 * receipt that recovery, a synchronous state transition, never holds.
 */
export function configWithSwitchedSeat(
  config: Config,
  seat: CrewSeatId,
  candidate: SeatSwapCandidate,
): Config | null {
  const runner = {
    kind: 'cli',
    tool: candidate.tool,
    ...(candidate.model !== undefined && { model: candidate.model }),
  };
  switch (seat) {
    case 'plan': {
      const parsed = PlannerConfigSchema.safeParse(runner);
      return parsed.success ? { ...config, planner: parsed.data } : null;
    }
    case 'build': {
      const parsed = ImplementerConfigSchema.safeParse(runner);
      return parsed.success ? configWithSwitchedBuildSeat(config, parsed.data) : null;
    }
    case 'review': {
      const parsed = ReviewerConfigSchema.safeParse(runner);
      return parsed.success ? { ...config, reviewer: parsed.data } : null;
    }
    default:
      return assertNever(seat);
  }
}
