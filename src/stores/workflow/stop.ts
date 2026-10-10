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
}

export interface StopState {
  intent: StopIntent;
  phase: StopPhase;
  requestedAt: number | null;
  parked: StopParked | null;
  error?: string;
}

const initial: StopState = { intent: 'none', phase: 'idle', requestedAt: null, parked: null };
const store = createStore<StopState>(initial);

function request(intent: Exclude<StopIntent, 'none'>): void {
  store.set((s) => ({ intent, phase: 'requested', requestedAt: Date.now(), parked: s.parked }));
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

function park(kind: StopParkKind, taskId: string | null, resolve: StopResolver | null): void {
  store.set((s) => ({ ...s, phase: 'parked', parked: { kind, taskId, resolve } }));
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
  markTerminating,
  markSettling,
  fail,
  markForcing,
  park,
  resume,
  end,
  __testReset,
};
