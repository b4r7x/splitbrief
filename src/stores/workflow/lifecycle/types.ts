import type { BriefClockState } from '../../../core/brief-clock.js';
import type { CrewSeatId } from '../../../core/crew/identity.js';
import type { RunnerKind, Phase } from '../../../core/schemas/enums.js';
import type { PlannerCall } from '../../../core/schemas/run-step.js';

type LifecycleStatus = 'idle' | 'running' | 'interrupted' | 'paused' | 'complete' | 'cancelled';

type LifecycleStall = {
  since: number;
  silentMs: number;
  runnerName: string | null;
  /** The backend kind of the stalled call; absent on records written before kinds. */
  backendKind?: RunnerKind | undefined;
} | null;

interface LifecycleBase {
  queueDepth: number;
  queuedMessageIds: ReadonlySet<string>;
  steerableCall: { seat: CrewSeatId; taskId?: string } | null;
  stall: LifecycleStall;
  retry: { attempt: number; delayMs: number } | null;
  /** When the run last produced any sign of life, so a silent seat can be named as silent. */
  lastRunnerEventTs?: number | null;
  briefClock?: BriefClockState | null;
  /** The planner call the phase is on, when the engine named one: a phase can hold two. */
  plannerCall?: PlannerCall | null;
  /**
   * Where the byline clock of that call starts: the moment it opened, or, for the first call since
   * the run started or resumed, that start — the preparation before it was the call's too.
   */
  plannerCallStartedTs?: number | null;
  /** When the run started waiting on the user, so that time stays out of the stage clock. */
  waitingSince?: number | null;
  /** Time already spent waiting on the user, by the phase it was spent in. */
  waitedMs?: Readonly<Partial<Record<Phase, number>>>;
  /** When a stopped run last started moving again, so the stage clock leaves its park out. */
  resumedAt?: number | null;
  /**
   * The lifecycle is the saved state read back from disk, and the engine has not started, resumed,
   * completed or cancelled the run since.
   */
  restored?: boolean;
}

interface IdleLifecycleState extends LifecycleBase {
  status: 'idle';
  interruptParked: false;
  cancelled: false;
  startedAt: null;
  endedAt: null;
  durationMs: null;
  reason: null;
}

export interface RunningLifecycleState extends LifecycleBase {
  status: 'running';
  interruptParked: false;
  cancelled: false;
  startedAt: number | null;
  endedAt: null;
  durationMs: null;
  reason: null;
}

// interruptParked distinguishes the dead-zone window (Esc-Esc landed but the
// continuation prompt has not reached a call boundary yet) from a parked prompt
// that actually owns the composer.
interface InterruptedLifecycleState extends LifecycleBase {
  status: 'interrupted';
  interruptParked: boolean;
  cancelled: false;
  startedAt: number | null;
  endedAt: null;
  durationMs: number | null;
  reason: null;
}

interface PausedLifecycleState extends LifecycleBase {
  status: 'paused';
  interruptParked: false;
  cancelled: false;
  startedAt: number | null;
  endedAt: number | null;
  durationMs: number | null;
  reason: null;
}

interface CompleteLifecycleState extends LifecycleBase {
  status: 'complete';
  interruptParked: false;
  cancelled: false;
  startedAt: number | null;
  endedAt: number | null;
  durationMs: number | null;
  reason: null;
}

interface CancelledLifecycleState extends LifecycleBase {
  status: 'cancelled';
  interruptParked: false;
  cancelled: true;
  startedAt: number | null;
  endedAt: number;
  durationMs: number;
  reason: string;
}

export type LifecycleState =
  | IdleLifecycleState
  | RunningLifecycleState
  | InterruptedLifecycleState
  | PausedLifecycleState
  | CompleteLifecycleState
  | CancelledLifecycleState;

export interface LifecycleResetState {
  status?: LifecycleStatus | undefined;
  cancelled?: boolean | undefined;
  queueDepth?: number | undefined;
  startedAt?: number | null | undefined;
  endedAt?: number | null | undefined;
  durationMs?: number | null | undefined;
  reason?: string | null | undefined;
}
