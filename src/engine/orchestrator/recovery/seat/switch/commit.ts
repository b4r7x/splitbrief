import { randomUUID } from 'node:crypto';
import { CREW_SEAT_ROLES } from '../../../../../core/crew/seats.js';
import { SeatAccountCauseSchema } from '../../../../../core/recovery/account-cause.js';
import { formatRecoveryHeadline } from '../../../../../core/recovery/headline.js';
import { recoveryFactString } from '../../../../../core/schemas/recovery/facts.js';
import { resolveSeatChangeIdentities } from '../../../../providers/model/display-names.js';
import { NULL_CACHE } from '../../../../providers/model/resolution.js';
import { publishSeatSwitched } from '../../../publish/seat.js';
import { publishRecoveryResolved } from '../../../publish/recovery.js';
import { publishReviewSeatRenderNote } from '../../../review/seat-note.js';
import { transitionAndSave } from '../../../state-ops/transition.js';
import { markRecoveryApplying } from '../../actions/shared.js';
import type { ApplyRecoveryActionOptions, ApplySwitchSeatResult } from '../../actions/types.js';
import type { SeatSwitchPlan } from './plan.js';

/**
 * The state half of a seat switch, run only once the seat's block is already in
 * `config.yaml`: the halt resolves, the switch is appended to `seatSwitches` and
 * `seat_switched` reaches the transcript. A halt that names a brief resolves
 * with `RESTART_ATTEMPT_ON_SEAT`, so the attempt and its parked step survive the
 * move; a seat-level halt re-issues its step the way a retry does.
 */
export function commitSeatSwitch(
  opts: ApplyRecoveryActionOptions,
  plan: SeatSwitchPlan,
  choice: Readonly<{ auto: boolean; configRevision: string }>,
): ApplySwitchSeatResult {
  const { issue, seat, candidate, from, switchedConfig } = plan;
  const switchId = randomUUID();
  const parsedCause = SeatAccountCauseSchema.safeParse(
    issue.reason === 'runner-unauthenticated' ? 'auth' : recoveryFactString(issue.facts, 'cause'),
  );
  const switchCause = {
    cause: issue.reason,
    ...(parsedCause.success && { accountCause: parsedCause.data }),
    headline: formatRecoveryHeadline(issue),
  };
  const briefHalt = issue.taskId !== undefined;
  let state = markRecoveryApplying(opts, issue);
  state =
    issue.taskId === undefined
      ? transitionAndSave(
          opts,
          state,
          { type: 'RESOLVE_PENDING_RECOVERY' },
          { expectedRevision: state.stateRevision ?? 0 },
        )
      : transitionAndSave(
          opts,
          state,
          {
            type: 'RESTART_ATTEMPT_ON_SEAT',
            taskId: issue.taskId,
            profile: seat === 'build' ? issue.selectedImplementerProfile : undefined,
          },
          { expectedRevision: state.stateRevision ?? 0 },
        );
  state = transitionAndSave(
    opts,
    state,
    {
      type: 'RECORD_SEAT_SWITCH',
      switchId,
      seat,
      ...resolveSeatChangeIdentities({
        from,
        to: candidate,
        role: CREW_SEAT_ROLES[seat],
        cache: opts.modelCache ?? NULL_CACHE,
      }),
      fromSeat: from,
      toSeat: candidate,
      ...switchCause,
      auto: choice.auto,
      configRevision: choice.configRevision,
    },
    { expectedRevision: state.stateRevision ?? 0 },
  );
  publishSeatSwitched(
    { bus: opts.bus, phase: state.phase },
    {
      switchId,
      seat,
      from,
      to: candidate,
      ...switchCause,
      auto: choice.auto,
      configRevision: choice.configRevision,
    },
  );
  publishReviewSeatRenderNote({
    bus: opts.bus,
    seat,
    state,
    config: switchedConfig,
    modelCache: opts.modelCache,
  });
  publishRecoveryResolved({
    bus: opts.bus,
    phase: state.phase,
    issue,
    action: 'switch-seat',
    outcome: briefHalt ? 'retry-current-task' : 'continued',
    ...(issue.selectedImplementerProfile !== undefined && {
      implementerProfile: issue.selectedImplementerProfile,
    }),
  });
  return {
    ok: true,
    action: 'switch-seat',
    issue,
    state,
    ...(briefHalt
      ? { status: 'retry-current-task' }
      : { status: 'continued', correctionRecorded: false }),
    switchedSeat: { seat, candidate },
    switchedConfig,
    ...(issue.selectedImplementerProfile !== undefined && {
      implementerProfile: issue.selectedImplementerProfile,
    }),
  };
}
