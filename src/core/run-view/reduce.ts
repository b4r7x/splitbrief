import {
  eventPhase,
  isInfrastructurePhaseEvent,
  type EventTypeCarrier,
} from '../phases/of-event.js';
import type { Phase } from '../schemas/enums.js';
import type { ClarificationQuestion } from '../schemas/question.js';
import type { StepRef } from '../schemas/run-step.js';
import type { SeatWait } from '../schemas/workflow/seat.js';
import type { CrewSeatId } from '../crew/identity.js';
import type { SeatIdentity } from '../providers/seat-identity.js';
import { seatForRunningCall } from '../runners/seat-roles.js';
import { EMPTY_BRIEFS, reduceBriefs, type RunBriefs } from './briefs.js';
import type {
  BriefKeptEvent,
  PlannerQuestionsAskedEvent,
  RunFailedEvent,
  RunRejectedEvent,
  RunnerModelEvent,
  SeatWaitEndedEvent,
  SeatWaitStartedEvent,
  TurnInterruptedEvent,
  WorkflowConfigEvent,
} from './events.js';
import { reduceHalt, type RunHalt } from './halt.js';

/** A seat waiting for a usage reset, as the run's log last stated it. */
export interface ViewSeatWait {
  /** The tool, in the catalog's words. */
  readonly tool: string;
  /** The wait as `state.json` saved it; `seatWaitMoved` reads its `holds`. */
  readonly wait: SeatWait;
  /** A process waits on it now; false once a stop or a steer cut it and only the saved wait stays. */
  readonly live: boolean;
}

/** An Apply of the run: when it began, and when it ended once it has. */
export interface ViewApply {
  readonly since: number;
  readonly until: number | null;
}

/** When the run first entered each phase: the rail dates a finished stage from the next one's entry. */
export type PhaseFirstSeen = Readonly<Partial<Record<Phase, number>>>;

/** The model a call reported, with the runner and model it was given. */
export type SeatResolvedModel = Readonly<
  Pick<RunnerModelEvent, 'runnerName' | 'model' | 'backendKind'> & { resolvedModel: string }
>;

/** What the run's log says about the run, folded once for every surface that shows it. */
export interface RunView {
  readonly phase: Phase;
  readonly phaseFirstSeen: PhaseFirstSeen;
  readonly seatWait: ViewSeatWait | null;
  readonly halt: RunHalt | null;
  readonly briefs: RunBriefs;
  /** The questions the run waits on the operator to answer. */
  readonly questions: readonly ClarificationQuestion[] | null;
  /** The run waits at the plan card, so a continue opens it again. */
  readonly planCard: boolean;
  /** What the last stop kept of the brief it cut mid-step: the files it wrote that are still changed, its declared files first. */
  readonly stopKept: readonly string[];
  /** The step the last stop landed on, until the run goes on. */
  readonly stopStep: StepRef | null;
  /** The error that stopped the run, until the run takes its step again. */
  readonly failure: string | null;
  /**
   * The files a put-back of the running brief still acts on after its last revert, restore or
   * denied write, until its next attempt starts; null while no such row was read.
   */
  readonly briefKept: number | null;
  readonly apply: ViewApply | null;
  /** The latest run pass has REVIEW None, so no seat reviews what it runs. */
  readonly reviewNone: boolean;
  readonly passSeats: SeatIdentity | null;
  readonly resolvedModels: Readonly<Partial<Record<CrewSeatId, SeatResolvedModel>>>;
  /**
   * The step after the last brief, as the saved state names it: only the state knows the
   * workspace, so a run the state has not settled yet reads the review.
   */
  readonly afterLastBrief: StepRef;
}

const NO_FILES: readonly string[] = [];

export const EMPTY_RUN_VIEW: RunView = {
  phase: 'idle',
  phaseFirstSeen: {},
  seatWait: null,
  halt: null,
  briefs: EMPTY_BRIEFS,
  questions: null,
  planCard: false,
  stopKept: NO_FILES,
  stopStep: null,
  failure: null,
  briefKept: null,
  apply: null,
  reviewNone: false,
  passSeats: null,
  resolvedModels: {},
  afterLastBrief: { kind: 'review', cycle: 0 },
};

type RunViewEvent = EventTypeCarrier & { readonly ts: number };

function isSeatWaitStarted<T extends EventTypeCarrier>(
  event: T,
): event is T & SeatWaitStartedEvent {
  return event.type === 'seat_wait_started';
}

function isSeatWaitEnded<T extends EventTypeCarrier>(event: T): event is T & SeatWaitEndedEvent {
  return event.type === 'seat_wait_ended';
}

function isQuestionsAsked<T extends EventTypeCarrier>(
  event: T,
): event is T & PlannerQuestionsAskedEvent {
  return event.type === 'planner_questions_asked';
}

function isTurnInterrupted<T extends EventTypeCarrier>(
  event: T,
): event is T & TurnInterruptedEvent {
  return event.type === 'turn_interrupted';
}

function isRunRejected<T extends EventTypeCarrier>(event: T): event is T & RunRejectedEvent {
  return event.type === 'run_rejected';
}

function isRunFailed<T extends EventTypeCarrier>(event: T): event is T & RunFailedEvent {
  return event.type === 'run_failed';
}

function isBriefKeptRow<T extends EventTypeCarrier>(event: T): event is T & BriefKeptEvent {
  return event.type === 'info' || event.type === 'warning' || event.type === 'error';
}

function isWorkflowConfig<T extends EventTypeCarrier>(event: T): event is T & WorkflowConfigEvent {
  return event.type === 'workflow_config';
}

function isRunnerModel<T extends EventTypeCarrier>(event: T): event is T & RunnerModelEvent {
  return event.type === 'runner_call_session_id';
}

/**
 * One event folded into the view. An event that changes nothing returns the same view, so a store
 * that holds it does not notify.
 */
export function reduceRunView(view: RunView, event: RunViewEvent): RunView {
  const withSeats = reduceSeatIdentity(view, event);
  const next = reduceBriefKept(
    reduceStop(reduceAsk(reduceSeatWait(reducePhase(withSeats, event), event), event), event),
    event,
  );
  const halt = reduceHalt(next.halt, event);
  const briefs = reduceBriefs(next.briefs, event);
  const apply = reduceApply(next.apply, event);
  if (halt === next.halt && briefs === next.briefs && apply === next.apply) return next;
  return { ...next, halt, briefs, apply };
}

function reduceSeatIdentity(view: RunView, event: RunViewEvent): RunView {
  if (isWorkflowConfig(event)) {
    const {
      plannerTool,
      plannerModel,
      plannerKind,
      plannerAxes,
      implementerTool,
      implementerModel,
      implementerKind,
      implementerAxes,
      reviewerTool,
      reviewerModel,
      reviewerKind,
      reviewerAxes,
      reviewerSeat,
    } = event;
    return {
      ...view,
      reviewNone: reviewerSeat === 'none',
      passSeats: {
        plannerTool,
        plannerModel,
        plannerKind,
        plannerAxes,
        implementerTool,
        implementerModel,
        implementerKind,
        implementerAxes,
        reviewerTool,
        reviewerModel,
        reviewerKind,
        reviewerAxes,
        reviewerSeat,
      },
    };
  }
  if (!isRunnerModel(event) || event.resolvedModel === undefined) return view;
  const seat = seatForRunningCall(event);
  if (seat === null) return view;
  const { runnerName, model, resolvedModel, backendKind } = event;
  return {
    ...view,
    resolvedModels: {
      ...view.resolvedModels,
      [seat]: { runnerName, model, resolvedModel, backendKind },
    },
  };
}

/**
 * The phase every phase event names. A run start begins the first-seen times again; the replay
 * markers carry the phase of the reading, not of the run, and `idle` is where a run stands before
 * its first phase, so neither moves it.
 */
function reducePhase(view: RunView, event: RunViewEvent): RunView {
  if (isInfrastructurePhaseEvent(event)) return view;
  const phase = eventPhase(event);
  if (event.type === 'workflow_started') {
    return {
      ...view,
      phase: phase ?? view.phase,
      phaseFirstSeen: phase === undefined ? {} : { [phase]: event.ts },
    };
  }
  if (phase === undefined || phase === 'idle') return view;
  const phaseFirstSeen =
    view.phaseFirstSeen[phase] === undefined
      ? { ...view.phaseFirstSeen, [phase]: event.ts }
      : view.phaseFirstSeen;
  if (phase === view.phase && phaseFirstSeen === view.phaseFirstSeen) return view;
  return { ...view, phase, phaseFirstSeen };
}

/** A start written before the log named its tool shows no wait. */
function reduceSeatWait(view: RunView, event: RunViewEvent): RunView {
  if (isSeatWaitStarted(event)) {
    if (event.tool === undefined || event.tool.trim() === '') return view;
    return {
      ...view,
      seatWait: {
        tool: event.tool,
        wait: event.wait ?? { seat: event.seat, resetAt: event.resetAt },
        live: true,
      },
    };
  }
  if (isSeatWaitEnded(event)) {
    if (view.seatWait === null) return view;
    return {
      ...view,
      seatWait: event.kept === true ? { ...view.seatWait, live: false } : null,
    };
  }
  return view;
}

/**
 * What the run asks the operator: the questions of a round until a reply answers them, and the
 * plan card until it is approved, ended or answered with a new plan. A run start asks nothing.
 */
function reduceAsk(view: RunView, event: RunViewEvent): RunView {
  if (isQuestionsAsked(event)) return { ...view, questions: event.questions };
  // Whatever the user sends next answers the round: the reply, or a correction that continues it.
  const questions =
    event.type === 'user_message' || event.type === 'workflow_started' ? null : view.questions;
  const planCard =
    event.type === 'plan_card_opened'
      ? true
      : event.type === 'plan_approved' ||
          event.type === 'plan_rejected' ||
          event.type === 'plan_regenerated' ||
          event.type === 'workflow_started'
        ? false
        : view.planCard;
  if (questions === view.questions && planCard === view.planCard) return view;
  return { ...view, questions, planCard };
}

/** Why the run stopped: the files a stop kept, the step it landed on, the error that stopped it. Taking the step again clears them. */
function reduceStop(view: RunView, event: RunViewEvent): RunView {
  if (isTurnInterrupted(event)) {
    return { ...view, stopKept: event.kept ?? NO_FILES, stopStep: event.step ?? null };
  }
  if (isRunFailed(event)) return { ...view, failure: event.message };
  // A reject that put a kept file back leaves it unchanged in the checkout.
  if (isRunRejected(event)) {
    const stopKept = view.stopKept.filter((file) => !event.restored.includes(file));
    return stopKept.length === view.stopKept.length ? view : { ...view, stopKept };
  }
  if (event.type !== 'workflow_resumed' && event.type !== 'workflow_started') return view;
  if (view.stopKept === NO_FILES && view.failure === null && view.stopStep === null) return view;
  return { ...view, stopKept: NO_FILES, stopStep: null, failure: null };
}

const ATTEMPT_STARTS = new Set([
  'implementer_generate_running',
  'task_started',
  'task_retry',
  'workflow_resumed',
]);

/** The count a revert, a restore or a denial row carries holds until the next attempt starts. */
function reduceBriefKept(view: RunView, event: RunViewEvent): RunView {
  if (isBriefKeptRow(event) && event.briefKept !== undefined)
    return event.briefKept === view.briefKept ? view : { ...view, briefKept: event.briefKept };
  if (!ATTEMPT_STARTS.has(event.type) || view.briefKept === null) return view;
  return { ...view, briefKept: null };
}

/** An Apply's clock: it starts with the Apply and stops when the Apply ends. */
function reduceApply(apply: ViewApply | null, event: RunViewEvent): ViewApply | null {
  if (event.type === 'apply_started') return { since: event.ts, until: null };
  if (event.type === 'apply_finished') return apply === null ? null : { ...apply, until: event.ts };
  return event.type === 'workflow_started' ? null : apply;
}
