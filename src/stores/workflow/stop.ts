import { createStore, storeBase } from '../create-store.js';
import type { UserMessageInput } from '../../core/types/user-input.js';

export type StopIntent = 'none' | 'stop-now' | 'pause-after-brief' | 'end-run' | 'quit';
export type StopPhase =
  | 'idle'
  | 'requested'
  | 'terminating'
  | 'forcing'
  | 'settling'
  | 'parked'
  | 'ended'
  | 'failed';
export type StopParkKind = 'mid-brief' | 'boundary';

export type StopResolver = (steer: UserMessageInput) => void;

export interface StopParked {
  kind: StopParkKind;
  taskId: string | null;
  resolve: StopResolver | null;
  /** The declared files a brief cut mid-step had changed, as the engine read them at the cut. */
  kept: readonly string[];
}

export interface StopState {
  intent: StopIntent;
  phase: StopPhase;
  requestedAt: number | null;
  parked: StopParked | null;
  /**
   * A seat was saved under the running run and is not taken yet: the run is re-prepared on it at
   * the next brief boundary and goes on. It is no stop, so it never sets the intent.
   */
  seatChange: boolean;
  error?: string;
}

const initial: StopState = {
  intent: 'none',
  phase: 'idle',
  requestedAt: null,
  parked: null,
  seatChange: false,
};
const store = createStore<StopState>(initial);

// A pause after this brief waits at the boundary a seat change waits on; a stop, an End run or a
// quit takes the run down before it, and the seat is read again when the run re-enters.
function request(intent: Exclude<StopIntent, 'none'>): void {
  store.set((s) => ({
    intent,
    phase: 'requested',
    requestedAt: Date.now(),
    parked: s.parked,
    seatChange: intent === 'pause-after-brief' && s.seatChange,
  }));
}

function markSeatChange(pending: boolean): void {
  store.set((s) => ({ ...s, seatChange: pending }));
}

/** The operator takes back a pause after this brief; a seat change it waited beside still waits. */
function cancelPause(): void {
  store.set((s) => ({ ...initial, seatChange: s.seatChange }));
}

function fail(message: string): void {
  store.set((s) => ({ ...s, phase: 'failed', error: message }));
}

function markSettling(): void {
  store.set((s) => ({ ...s, phase: 'settling' }));
}

function markTerminating(): void {
  store.set((s) => ({ ...s, phase: 'terminating' }));
}

function markForcing(): void {
  store.set((s) => ({ ...s, phase: 'forcing' }));
}

function park(
  kind: StopParkKind,
  taskId: string | null,
  resolve: StopResolver | null,
  kept: readonly string[] = [],
): void {
  store.set((s) => ({ ...s, phase: 'parked', parked: { kind, taskId, resolve, kept } }));
}

function resume(steer: UserMessageInput): boolean {
  const { phase, parked } = store.get();
  if (phase !== 'parked' || parked === null || parked.resolve === null) return false;
  store.set(initial);
  parked.resolve(steer);
  return true;
}

function end(): void {
  store.set((s) => ({ ...s, phase: 'ended', parked: null }));
}

// Test escape hatch — see docs/STORES.md#test-escape-hatches. Do not use outside tests.
function __testReset(next?: Partial<StopState>): void {
  store.set(next ? { ...initial, ...next } : initial);
}

export const stopStore = {
  ...storeBase(store),
  request,
  markSeatChange,
  cancelPause,
  markTerminating,
  markSettling,
  fail,
  markForcing,
  park,
  resume,
  end,
  __testReset,
};
