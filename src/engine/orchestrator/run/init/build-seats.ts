import type { Config } from '../../../../core/schemas/config.js';
import type { WorkflowState } from '../../../../core/schemas/workflow/state.js';
import type { EventBus } from '../../../events/types.js';
import type { ModelCacheAccessor } from '../../../providers/model/runtime-snapshot.js';
import type { CustomRunnerRuntimePort } from '../../../runners/types.js';
import { publishError } from '../../publish/notice.js';
import { autoCompactResumeContext, applyRebuiltContext } from '../../transcript/resume-context.js';
import type { ResumeContextHolder } from '../../types.js';
import { publishResumedSteer } from './resume-repair.js';
import type { RunWorkflowOptions } from './options.js';
import { plannerUnavailableMessage } from './custom-runtime.js';
import { buildSkillsContext } from '../skills-context.js';
import {
  createPlannerSeat,
  createImplementerSeat,
  type ImplementerSeat,
  type PlannerSeat,
} from './seats.js';

type SeatStepInput = Readonly<{
  opts: RunWorkflowOptions;
  config: Config;
  projectDir: string;
  workspaceDir: string;
  sessionId: string;
  bus: EventBus;
  customRuntime: CustomRunnerRuntimePort;
  modelCache: ModelCacheAccessor;
  resumeHolder: ResumeContextHolder;
  setTrackedState: (s: WorkflowState) => void;
  savedState: WorkflowState | undefined;
  planSeatChanged: boolean;
  hasPendingRecovery: boolean;
}>;

type RunSeats =
  | Readonly<{ ok: false; savedState: WorkflowState | undefined }>
  | Readonly<{
      ok: true;
      savedState: WorkflowState | undefined;
      skills: Awaited<ReturnType<typeof buildSkillsContext>>;
      plannerSeat: PlannerSeat;
      implementerSeat: ImplementerSeat;
    }>;

/** Builds the planner seat, gives a resumed planner its context, and builds the implementer seat once the planner is available. */
export async function buildSeats(input: SeatStepInput): Promise<RunSeats> {
  const { opts, config, projectDir, sessionId, bus, setTrackedState } = input;
  const { planSeatChanged, hasPendingRecovery } = input;
  const savedState = input.savedState;
  // Every seat carries the run's skills, so the block is built before the first seat is.
  const skills = await buildSkillsContext({
    projectDir,
    bus,
    phase: savedState?.phase ?? 'idle',
    selected: opts.selectedSkills,
    persisted: savedState?.selectedSkills,
  });
  // Stateless backends receive priorMessages instead of plannerSessionId.
  const initialSessionId = savedState?.plannerSessionId ?? null;
  const plannerSeat = await createPlannerSeat({
    config,
    prepared: opts.prepared,
    customRuntime: input.customRuntime,
    projectDir,
    initialSessionId,
    injectedPlanner: opts._planner,
    injectedReviewer: opts._reviewer,
    skillRoots: skills.skillRoots,
    signal: opts.signal,
    modelCache: input.modelCache,
  });
  const { planner } = plannerSeat;
  if (savedState && !hasPendingRecovery) {
    await autoCompactResumeContext({
      projectDir,
      workspaceDir: input.workspaceDir,
      sessionId,
      bus,
      config,
      planner,
      state: savedState,
      ...(opts.signal !== undefined && { signal: opts.signal }),
    });
    setTrackedState(savedState);
    // A seat with no thread to resume (moved, stateless, or its thread expired) gets the transcript.
    if (
      planSeatChanged ||
      !planner.capabilities.supportsSessionResume ||
      !savedState.plannerSessionId
    ) {
      await applyRebuiltContext({
        projectDir,
        sessionId,
        bus,
        resumeHolder: input.resumeHolder,
        requireNonEmpty: true,
      });
    }
  }
  // After the rebuild: the continuation hands the steer to the step it resumes.
  publishResumedSteer({ bus, projectDir, sessionId, state: savedState, steer: opts.steer });
  if (!hasPendingRecovery) {
    // A stop during the check ends the start; it says nothing about the planner.
    const available = await planner.isAvailable().catch((cause: unknown) => {
      if (opts.signal?.aborted === true) return false;
      throw cause;
    });
    if (!available) {
      if (opts.signal?.aborted !== true) {
        publishError({
          bus: bus,
          phase: savedState?.phase ?? 'idle',
          message: plannerUnavailableMessage(config.planner, planner),
        });
      }
      return { ok: false, savedState };
    }
  }

  const implementerSeat = await createImplementerSeat({
    config,
    prepared: opts.prepared,
    customRuntime: input.customRuntime,
    bus,
    injectedImplementer: opts._implementer,
    signal: opts.signal,
  });
  return { ok: true, savedState, skills, plannerSeat, implementerSeat };
}
