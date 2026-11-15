import { createStore, storeBase } from '../create.js';
import { preparationStore } from '../navigation/preparation.js';
import { routerStore } from '../navigation/router.js';
import type { UserMessageInput } from '../../core/types/user-input.js';
import { lifecycleStore } from './lifecycle/state.js';
import { runViewStore } from './run-view.js';

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
  /** The files a brief cut mid-step wrote that are still changed, its declared files first, as the engine read them at the cut. */
  kept: readonly string[];
}

export interface StopState {
  intent: StopIntent;
  phase: StopPhase;
  requestedAt: number | null;
  parked: StopParked | null;
  /**
   * A seat was saved under the running run and is not taken yet: the run is re-prepared on it at
   * the next brief or review boundary and goes on. It is no stop, so it never sets the intent.
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

/**
 * Whether the run this process drives takes a seat saved now at a brief or review boundary: it
 * runs, or it waits parked and goes on at the boundary when it continues. A halt's own picker
 * moves its seat at once, so a halted run waits for no boundary.
 */
export function takesSeatAtBoundary(): boolean {
  const { status } = lifecycleStore.get();
  return (status === 'running' || status === 'paused') && runViewStore.get().halt === null;
}

/**
 * Whether a setting saved now lands only when the run runs again or continues from its Resume: a
 * start or a Resume checking its tools runs on the config it read before the check, on whatever
 * route it waits, and the local run this process drives keeps the config it prepared. A run at
 * rest, a finished run and a stop that ended the run prepare again from the file, so their save is
 * a plain save.
 */
export function keepsPreparedSettings(): boolean {
  if (preparationStore.get().kind === 'checking') return true;
  const route = routerStore.get();
  if (route.screen !== 'workflow' || route.execution.kind !== 'local') return false;
  const stop = store.get();
  if (stop.phase === 'ended') return false;
  const { status } = lifecycleStore.get();
  if (status === 'complete') return false;
  return status === 'running' || status === 'paused' || parksCutCall(stop);
}

/** A stop parked the run inside a call, and the run goes on with that call when it continues. */
export function parksCutCall({ phase, parked }: StopState): boolean {
  return phase === 'parked' && parked?.kind === 'mid-brief' && parked.resolve !== null;
}

/**
 * A stop, an End run or a quit was asked for and has not parked, ended or failed yet: a Resume and
 * a steer are refused until it settles. A pause after the brief stops nothing, so it is no stop.
 */
export function stopInProgress({ intent, phase }: StopState): boolean {
  if (intent === 'none' || intent === 'pause-after-brief') return false;
  return phase !== 'parked' && phase !== 'ended' && phase !== 'failed';
}

export function stoppedOrStopping(): boolean {
  const { phase, intent } = store.get();
  return (
    phase === 'parked' || phase === 'ended' || (intent !== 'none' && intent !== 'pause-after-brief')
  );
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

// Test escape hatch — see docs/STORES-AND-UI.md#test-escape-hatches. Do not use outside tests.
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
