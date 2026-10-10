import type { Config } from '../../../core/schemas/config.js';
import { ImplementerConfigSchema } from '../../../core/schemas/implementer-config.js';
import {
  readImplementerProfileConfig,
  updateDefaultImplementerConfig,
  updateNamedImplementerConfig,
} from '../../../core/config/accessors/implementer-profiles.js';
import { PlannerConfigSchema } from '../../../core/schemas/planner-config.js';
import { ReviewerConfigSchema } from '../../../core/schemas/reviewer-config.js';
import type { SeatSwapCandidate } from '../../../core/schemas/recovery/schemas.js';
import type { CrewSeatId } from '../../../core/crew/identity.js';
import type { RunnerConfig } from '../../../core/config/accessors/runner-config.js';
import type { SeatRunnerValue } from '../../../core/config/load/record-seat.js';
import { runnerEffortChannel } from '../../../core/runners/effort-channel.js';
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
  implementerProfile: string | undefined,
  candidate: SeatSwapCandidate,
  auto: boolean,
  fallbackOfRecord: Pick<RunnerConfig, 'fallback'> | undefined,
): Config | null {
  const existing = readImplementerProfileConfig(config, implementerProfile);
  if (existing === undefined) return null;
  const parsed = ImplementerConfigSchema.safeParse(
    switchedRunner(existing, candidate, auto, fallbackOfRecord),
  );
  if (!parsed.success) return null;
  const update = () => parsed.data;
  return implementerProfile === undefined
    ? updateDefaultImplementerConfig(config, update)
    : updateNamedImplementerConfig(config, implementerProfile, update);
}

function switchedRunner(
  existing: RunnerConfig,
  candidate: SeatSwapCandidate,
  auto: boolean,
  fallbackOfRecord: Pick<RunnerConfig, 'fallback'> | undefined,
) {
  const channel = runnerEffortChannel(existing);
  const fallback = auto
    ? existing.kind === 'cli'
      ? {
          tool: existing.tool,
          ...(existing.model !== undefined && { model: existing.model }),
          ...(channel === 'effort-flag' &&
            existing.effort !== undefined && {
              effort: existing.effort,
            }),
          ...(channel === 'variant' &&
            existing.variant !== undefined && {
              variant: existing.variant,
            }),
        }
      : undefined
    : fallbackOfRecord === undefined
      ? existing.fallback
      : fallbackOfRecord.fallback;
  return {
    kind: 'cli',
    ...candidate,
    ...(fallback !== undefined && { fallback }),
  };
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
  auto = false,
  fallbackOfRecord?: Pick<RunnerConfig, 'fallback'> | undefined,
): Config | null {
  switch (seat) {
    case 'plan': {
      const parsed = PlannerConfigSchema.safeParse(
        switchedRunner(config.planner, candidate, auto, fallbackOfRecord),
      );
      return parsed.success ? { ...config, planner: parsed.data } : null;
    }
    case 'build': {
      return configWithSwitchedBuildSeat(
        config,
        implementerProfile,
        candidate,
        auto,
        fallbackOfRecord,
      );
    }
    case 'review': {
      const parsed = ReviewerConfigSchema.safeParse(
        switchedRunner(config.reviewer ?? config.planner, candidate, auto, fallbackOfRecord),
      );
      return parsed.success ? { ...config, reviewer: parsed.data } : null;
    }
    default:
      return assertNever(seat);
  }
}

function runnerTool(runner: SeatRunnerValue): string {
  switch (runner.kind) {
    case 'cli':
      return runner.tool;
    case 'api':
      return runner.provider;
    case 'shell':
      return 'shell';
    case 'agent':
      return 'agent';
    default:
      return assertNever(runner);
  }
}

/** A configured seat as a swap identity, so a switch can name the tool it leaves. */
export function seatCandidateOfRunner(runner: SeatRunnerValue): SeatSwapCandidate {
  const model = 'model' in runner && typeof runner.model === 'string' ? runner.model : undefined;
  const effort = 'effort' in runner ? runner.effort : undefined;
  const variant = 'variant' in runner ? runner.variant : undefined;
  return {
    tool: runnerTool(runner),
    ...(model !== undefined && { model }),
    ...(effort !== undefined && { effort }),
    ...(variant !== undefined && { variant }),
  };
}
