import { eventPhase, isInfrastructurePhaseEvent, type EventTypeCarrier } from '../event-phase.js';
import type { CrewSeatId } from '../crew/identity.js';
import type { Phase } from '../schemas/enums.js';
import type { SeatWait } from '../schemas/workflow.js';

type SeatWaitStartedEvent = {
  type: 'seat_wait_started';
  seat: CrewSeatId;
  resetAt: string;
  tool?: string | undefined;
  wait?: SeatWait | undefined;
};
type SeatWaitEndedEvent = { type: 'seat_wait_ended'; seat: CrewSeatId; kept?: true | undefined };

/** A seat waiting for a usage reset, as the run's log last stated it. */
export interface ViewSeatWait {
  /** The tool, in the catalog's words. */
  readonly tool: string;
  /** The wait as `state.json` saved it; `seatWaitMoved` reads its `holds`. */
  readonly wait: SeatWait;
  /** A process waits on it now; false once a stop or a steer cut it and only the saved wait stays. */
  readonly live: boolean;
}

/** When the run first entered each phase: the rail dates a finished stage from the next one's entry. */
export type PhaseFirstSeen = Readonly<Partial<Record<Phase, number>>>;

/** What the run's log says about the run, folded once for every surface that shows it. */
export interface RunView {
  readonly phase: Phase;
  readonly phaseFirstSeen: PhaseFirstSeen;
  readonly seatWait: ViewSeatWait | null;
}

export const EMPTY_RUN_VIEW: RunView = { phase: 'idle', phaseFirstSeen: {}, seatWait: null };

type RunViewEvent = EventTypeCarrier & { readonly ts: number };

function isSeatWaitStarted<T extends EventTypeCarrier>(
  event: T,
): event is T & SeatWaitStartedEvent {
  return event.type === 'seat_wait_started';
}

function isSeatWaitEnded<T extends EventTypeCarrier>(event: T): event is T & SeatWaitEndedEvent {
  return event.type === 'seat_wait_ended';
}

/**
 * One event folded into the view. An event that changes nothing returns the same view, so a store
 * that holds it does not notify.
 */
export function reduceRunView(view: RunView, event: RunViewEvent): RunView {
  return reduceSeatWait(reducePhase(view, event), event);
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
