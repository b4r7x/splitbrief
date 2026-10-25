import type { Config } from '../../../core/schemas/config.js';
import {
  idsOf,
  isSeatIdentity,
  sameSeatIds,
  seatIdsOf,
  type CrewSeatId,
  type formatSeatIdentity,
  type SeatIds,
} from '../../../core/crew/identity.js';
import { CREW_SEAT_ROLES } from '../../../core/crew/seats.js';
import { seatForRunningCall } from '../../../core/runners/seat-roles.js';
import { resolveImplementerProfiles } from '../../../core/config/accessors/implementer-profiles.js';
import { configuredReviewerRunner } from '../../../core/config/accessors/reviewer-runner.js';
import type { SeatIdentity } from '../../../core/providers/seat-identity.js';
import { recordedSeatIdentityInput } from './recorded-seat-identity.js';
import type { ActiveOperation } from '../../../stores/workflow/operations/state.js';
import { isStatusFallback } from '../../../stores/workflow/operations/planner-status.js';
import type { LifecycleState } from '../../../stores/workflow/lifecycle.js';
import { selectRunningBrief, type TasksState } from '../../../stores/workflow/tasks.js';
import { assertNever } from '../../../utils/type-guards.js';

export type RunningSeats = Partial<Record<CrewSeatId, Parameters<typeof formatSeatIdentity>[0]>>;

type SeatRecord = Readonly<{ runnerName?: string | undefined } & Omit<SeatIds, 'tool'>>;

/** One seat of the run pass, or `null` when the log that announced the pass kept no axis words. */
function passSeatRecord(seatId: CrewSeatId, pass: SeatIdentity): SeatRecord | null {
  switch (seatId) {
    case 'plan':
      return pass.plannerAxes === undefined
        ? null
        : {
            runnerName: pass.plannerTool,
            model: pass.plannerModel,
            axes: pass.plannerAxes,
            kind: pass.plannerKind,
          };
    case 'build':
      return pass.implementerAxes === undefined
        ? null
        : {
            runnerName: pass.implementerTool,
            model: pass.implementerModel,
            axes: pass.implementerAxes,
            kind: pass.implementerKind,
          };
    case 'review':
      // A pass without a review seat of its own gives the reviews to its planner.
      if (pass.reviewerTool === undefined) return passSeatRecord('plan', pass);
      return pass.reviewerAxes === undefined
        ? null
        : {
            runnerName: pass.reviewerTool,
            model: pass.reviewerModel,
            axes: pass.reviewerAxes,
            kind: pass.reviewerKind,
          };
    default:
      return assertNever(seatId);
  }
}

function seatOverride(
  seatId: CrewSeatId,
  recorded: SeatRecord,
  savedSeat: SeatIds,
): RunningSeats[CrewSeatId] {
  const runningIdentity = recordedSeatIdentityInput({
    runnerName: recorded.runnerName,
    model: recorded.model,
    axes: recorded.axes,
    backendKind: recorded.kind,
    role: CREW_SEAT_ROLES[seatId],
  });
  if (runningIdentity === null) return undefined;

  const runningSeat = idsOf(runningIdentity.seat);
  const isSame =
    (isSeatIdentity(runningSeat, savedSeat) || isSeatIdentity(savedSeat, runningSeat)) &&
    (savedSeat.model === undefined || sameSeatIds(savedSeat, runningSeat));
  return isSame ? undefined : runningIdentity;
}

/**
 * The seats the live work runs on where they differ from the saved ones. Each seat takes the
 * first of: its running call, for BUILD the route of the running brief, and the seat of the run
 * pass, which holds until the next pass starts. A stop parked inside a call keeps that call's
 * seat, since the run goes on with it. A stop that takes the run down, a halt or a run at rest
 * takes the saved seat, which is the one the run goes on with.
 */
export function deriveRunningSeats(input: {
  active: ActiveOperation | null | undefined;
  config: Config;
  tasks: TasksState;
  lifecycle: Pick<LifecycleState, 'status' | 'phase'>;
  halted: boolean;
  cutCallParked: boolean;
  passSeats: SeatIdentity | null;
}): RunningSeats {
  const { active, config, tasks, lifecycle, halted, cutCallParked, passSeats } = input;
  const live =
    (lifecycle.status === 'running' || lifecycle.status === 'interrupted' || cutCallParked) &&
    !halted;
  const brief = live ? selectRunningBrief(tasks, lifecycle.phase).current : null;
  const call = active?.status === 'running' && !isStatusFallback(active) ? active : null;
  const callSeatId = call === null ? null : seatForRunningCall(call);

  const recordOf = (seatId: CrewSeatId): SeatRecord | null => {
    if (call !== null && callSeatId === seatId) {
      return {
        runnerName: call.runnerName,
        model: call.model,
        axes: call.axes,
        kind: call.backendKind,
      };
    }
    if (!live) return null;
    if (seatId === 'build' && brief?.status === 'in_progress' && brief.route !== undefined) {
      return {
        runnerName: brief.route.runner,
        model: brief.route.model,
        axes: brief.route.axes,
        kind: brief.route.backendKind,
      };
    }
    return passSeats === null ? null : passSeatRecord(seatId, passSeats);
  };
  const overrideOf = (seatId: CrewSeatId, savedSeat: SeatIds): RunningSeats[CrewSeatId] => {
    const record = recordOf(seatId);
    return record === null ? undefined : seatOverride(seatId, record, savedSeat);
  };

  const plan = overrideOf('plan', seatIdsOf(config.planner));
  const build = overrideOf(
    'build',
    seatIdsOf(resolveImplementerProfiles(config).defaultProfile.config),
  );
  const savedReviewer = configuredReviewerRunner(config);
  // A saved REVIEW that follows PLAN follows the PLAN seat shown, so it keeps reading = PLAN.
  const review = overrideOf(
    'review',
    savedReviewer !== undefined
      ? seatIdsOf(savedReviewer)
      : plan !== undefined
        ? idsOf(plan.seat)
        : seatIdsOf(config.planner),
  );
  return {
    ...(plan !== undefined && { plan }),
    ...(build !== undefined && { build }),
    ...(review !== undefined && { review }),
  };
}
