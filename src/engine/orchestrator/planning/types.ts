import type { WorkflowState } from '../../../core/schemas/workflow/state.js';
import type { Task } from '../../../core/schemas/task.js';
import type { UserMessageInput } from '../../../core/types/user-input.js';
import type { PlannerCallbacksContext } from '../types.js';
import type { Planner, PriorMessage } from '../../planners/types.js';
import type { Attachment } from '../../../core/schemas/attachment.js';

export type PlanningPhaseOptions = {
  wctx: PlannerCallbacksContext;
  planner: Planner;
  state: WorkflowState;
  feature: string;
  rewindPending?: { comment?: string | undefined } | undefined;
  attachments?: Attachment[] | undefined;
  /**
   * Gate the run's first real planner call (the `pre_planning` hook). Returning
   * false cancels the turn. Called once per process, by whichever path issues
   * that call.
   */
  beforeFirstCall?: (() => Promise<boolean>) | undefined;
};

/** What the turns of one planning session change as they run. */
export type PlanningTurnState = {
  state: WorkflowState;
  /** The steer that answers the open question of a continued session, until a round takes it. */
  resumedAnswer: UserMessageInput | undefined;
  /** The first turn returned: a planner on its own session heard the lead and the steer. */
  standingHeard: boolean;
  /** The attachments and the steer's images, carried by each call of the first turn only. */
  images: Attachment[];
  /** The rebuilt transcript, sent with each call of the first turn only. */
  priorMessages: PriorMessage[] | undefined;
};

/**
 * How a planning phase stopped. `closed` is the user ending the run at a gate,
 * `interrupted` an abort that parked the step, `halted` a recovery the operator
 * has to answer; only `failed` is an error nothing can resume from in place.
 */
export type PlanningTerminalOutcome =
  | 'cancelled'
  | 'closed'
  | 'failed'
  | 'interrupted'
  | 'halted'
  | 'input-required';

export type PlanningPhaseResult =
  | Readonly<{ disposition: 'ready-for-tasks'; state: WorkflowState; tasks: readonly Task[] }>
  | Readonly<{
      disposition: 'terminal';
      state: WorkflowState;
      outcome: PlanningTerminalOutcome;
    }>;

export type PlanningProducerResult =
  | Readonly<{ disposition: 'tasks-ready'; state: WorkflowState; tasks: readonly Task[] }>
  | Readonly<{
      disposition: 'terminal';
      state: WorkflowState;
      outcome: PlanningTerminalOutcome;
    }>;

/** What a plan is checked against: the build seat's context, the project, the run's skills. */
export type PlanCheckContext = Pick<
  PlannerCallbacksContext,
  | 'config'
  | 'projectDir'
  | 'workspaceDir'
  | 'modelCache'
  | 'detectedContextLength'
  | 'skillsContext'
>;
