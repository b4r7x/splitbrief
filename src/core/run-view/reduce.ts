import type { EventTypeCarrier } from '../event-phase.js';
import type { CrewSeatId } from '../crew/identity.js';
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

/** What the run's log says about the run, folded once for every surface that shows it. */
export interface RunView {
  readonly seatWait: ViewSeatWait | null;
}

export const EMPTY_RUN_VIEW: RunView = { seatWait: null };

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
 * that holds it does not notify. A start written before the log named its tool shows no wait.
 */
export function reduceRunView(view: RunView, event: EventTypeCarrier): RunView {
  if (isSeatWaitStarted(event)) {
    if (event.tool === undefined || event.tool.trim() === '') return view;
    return {
      seatWait: {
        tool: event.tool,
        wait: event.wait ?? { seat: event.seat, resetAt: event.resetAt },
        live: true,
      },
    };
  }
  if (isSeatWaitEnded(event)) {
    if (view.seatWait === null) return view;
    return event.kept === true ? { seatWait: { ...view.seatWait, live: false } } : EMPTY_RUN_VIEW;
  }
  return view;
}
