import { readActiveRunner } from '../../../../core/config/accessors/active-runner.js';
import { readConfigDocument } from '../../../../core/config/load/document.js';
import { resolveApproveLevel } from '../../../../core/config/runtime/resolve.js';
import { sameSeatCandidate } from '../../../../core/crew/identity.js';
import { CREW_SEAT_ROLES } from '../../../../core/crew/seats.js';
import type { Config } from '../../../../core/schemas/config.js';
import type { WorkflowState } from '../../../../core/schemas/workflow/state.js';
import { reconcileSeatIdentities } from '../../../../core/state/seats/changes.js';
import { recordInterruptedCalls } from '../../../calls/interrupted.js';
import { readRunEvents } from '../../../events/replay.js';
import type { EventBus } from '../../../events/types.js';
import {
  resolveCrewDisplayNames,
  labelSeatChange,
} from '../../../providers/model/display-names.js';
import type { ModelCacheAccessor } from '../../../providers/model/runtime-snapshot.js';
import { resumeSeatWait } from '../../escalation/seat/wait.js';
import { publishSeatSwitched } from '../../publish/seat.js';
import { seedUsageLimitSteps } from '../../publish/usage-limit-gate.js';
import { seatCandidateOfRunner } from '../../recovery/seat/switch/config.js';
import { publishReviewSeatRenderNote } from '../../review/seat-note.js';
import { transitionAndSave } from '../../state-ops/transition.js';
import { commitWorkflowState } from '../../state-ops/commit.js';
import { readWorkflowStateHead } from '../../state-ops/head.js';
import { stateOpsError } from '../../state-ops/errors.js';
import {
  realignPassedTaskIndex,
  restoreUnresumedBriefCut,
  settleStaleHalt,
  isTaskInFlight,
  restartInterruptedTask,
} from './resume-repair.js';

type SavedStateContext = Readonly<{
  projectDir: string;
  sessionId: string;
  bus: EventBus;
  config: Config;
  modelCache: ModelCacheAccessor;
}>;

type SavedStateInput = SavedStateContext &
  Readonly<{
    savedState: WorkflowState | undefined;
    setTrackedState: (s: WorkflowState) => void;
    signal: AbortSignal | undefined;
  }>;

type SettledSavedState = Readonly<{
  savedState: WorkflowState | undefined;
  planSeatChanged: boolean;
  /** Read before a persisted seat wait is honored. */
  hasPendingRecovery: boolean;
}>;

function pinApproveLevel(ctx: SavedStateContext, savedState: WorkflowState): WorkflowState {
  const { projectDir, sessionId } = ctx;
  const approve = resolveApproveLevel(ctx.config);
  if (savedState.approve === approve) return savedState;
  const head = readWorkflowStateHead({ projectDir, sessionId });
  const pinned = commitWorkflowState({
    ref: { projectDir, sessionId },
    expected: head === null ? null : savedState,
    next: { ...savedState, approve },
  });
  if (pinned.kind === 'conflict') {
    throw stateOpsError.conflict(sessionId, {
      operation: 'transition',
      expectedRevision: savedState.stateRevision ?? null,
      observedRevision:
        readWorkflowStateHead({ projectDir, sessionId })?.state.stateRevision ?? null,
      attempts: 0,
      retryLimit: 0,
    });
  }
  if (pinned.kind === 'durability-uncertain') throw stateOpsError.durabilityUncertain(sessionId);
  return pinned.state;
}

/** Compares the seat record with the config, publishes each change no seat switch recorded, and tells whether the plan seat moved. */
async function reconcileSeatRecord(
  ctx: SavedStateContext,
  savedState: WorkflowState,
): Promise<boolean> {
  const { projectDir, sessionId, bus, config, modelCache } = ctx;
  let planSeatChanged = false;
  const changes = reconcileSeatIdentities(
    { projectDir, sessionId },
    config,
    resolveCrewDisplayNames(config, modelCache),
  );
  const events =
    changes.length === 0 ? [] : (await readRunEvents({ projectDir, sessionId })).events;
  const lastRun = events.findLastIndex(
    (event) => event.type === 'workflow_started' || event.type === 'workflow_resumed',
  );
  const recordedSwitches = events
    .slice(lastRun + 1)
    .filter((event) => event.type === 'seat_switched');
  for (const change of changes) {
    if (change.seat === 'plan') planSeatChanged = true;
    const recordedSwitch = recordedSwitches.findLast((event) => event.seat === change.seat);
    const recordedChange =
      recordedSwitch !== undefined &&
      typeof recordedSwitch.to !== 'string' &&
      sameSeatCandidate(
        recordedSwitch.to,
        seatCandidateOfRunner(
          readActiveRunner({
            config,
            role: CREW_SEAT_ROLES[change.seat],
            profile: change.profile,
          }),
        ),
      );
    if (!recordedChange) {
      const labelled = labelSeatChange(change, modelCache);
      publishSeatSwitched(
        { bus, phase: savedState.phase },
        {
          seat: change.seat,
          from: labelled.before,
          to: labelled.after,
          cause: 'crew-changed',
          auto: false,
          configRevision: readConfigDocument(projectDir).revision?.rawSha256 ?? '',
        },
      );
      publishReviewSeatRenderNote({
        bus,
        seat: change.seat,
        state: savedState,
        config,
        modelCache,
      });
    }
  }
  return planSeatChanged;
}

/** Brings a saved state to the point the resume continues from; a new run has none and passes through. */
export async function settleSavedState(input: SavedStateInput): Promise<SettledSavedState> {
  const { projectDir, sessionId, bus, config, setTrackedState } = input;
  if (input.savedState === undefined) {
    return { savedState: undefined, planSeatChanged: false, hasPendingRecovery: false };
  }
  let savedState = pinApproveLevel(input, input.savedState);
  setTrackedState(savedState);
  await recordInterruptedCalls({ projectDir, sessionId, bus }, savedState);
  seedUsageLimitSteps(bus, (await readRunEvents({ projectDir, sessionId })).events);
  // Every resume passes here, from the app and from the CLI alike, so this is
  // the one place the record is compared and rewritten. A moved plan seat also drops the
  // saved planner session on disk, so a later save in this init does not bring it back:
  // it belongs to the tool that left, so the context is rebuilt once the planner
  // seat is built rather than handed to a tool that cannot resume it. A change no
  // seat switch of this run recorded is recorded here as one.
  const planSeatChanged = await reconcileSeatRecord(input, savedState);
  if (planSeatChanged && savedState.plannerSessionId) {
    savedState = transitionAndSave(
      { projectDir, sessionId },
      savedState,
      { type: 'SET_PLANNER_SESSION_ID', sessionId: null },
      { expectedRevision: savedState.stateRevision },
    );
    setTrackedState(savedState);
  }
  savedState = realignPassedTaskIndex(bus, savedState);
  savedState = await restoreUnresumedBriefCut({ projectDir, sessionId, bus, state: savedState });
  savedState = await settleStaleHalt({ projectDir, sessionId, bus, state: savedState });
  setTrackedState(savedState);
  if (savedState.pendingRecovery === undefined && isTaskInFlight(savedState)) {
    savedState = await restartInterruptedTask({ projectDir, sessionId, bus, state: savedState });
    setTrackedState(savedState);
  }
  const hasPendingRecovery = savedState.pendingRecovery !== undefined;
  // A rate-limit wait the run persisted before it stopped is honored first: a
  // deadline still in the future is waited for, one already past is released,
  // and only then does the task continue.
  if (!hasPendingRecovery && savedState.seatWait !== undefined) {
    savedState = await resumeSeatWait({
      ref: { projectDir, sessionId, bus },
      state: savedState,
      config,
      ...(input.signal !== undefined && { signal: input.signal }),
    });
    setTrackedState(savedState);
  }
  return { savedState, planSeatChanged, hasPendingRecovery };
}
