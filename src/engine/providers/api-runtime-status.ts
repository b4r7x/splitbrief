import type { z } from 'zod';
import type { RunnerCallApiRuntimeStatusSchema } from '../calls/schema.js';
import type { ApiRuntimeContext } from './runtime-context.js';

/**
 * How far one dispatched API call has got, as the application itself saw it.
 * There is no `loading` member: a server that has not said it is loading or
 * generating has not proved that it is, so a call that has asked and heard
 * nothing back is waiting — whatever the model's observed load state says.
 */
export type ApiRuntimePhase = ApiRuntimeStatus['phase'];

/**
 * One dispatched call's waiting state. `loadState` repeats the server's own
 * word and `observedAt` says when that word was taken; nothing here infers
 * either from the call's own progress. `finished` means SPLITBRIEF stopped
 * waiting — by completion, deadline or cancellation — and claims nothing about
 * what the external server is still doing with the model.
 */
export type ApiRuntimeStatus = z.infer<typeof RunnerCallApiRuntimeStatusSchema>;

/** What one call's transport recorded, oldest first. */
export type ApiRuntimeSignal = 'dispatched' | 'chunk' | 'settled';

/** The part of an admitted runtime context a waiting state may repeat. */
export type ApiRuntimeObservation = Pick<
  ApiRuntimeContext,
  'contextKey' | 'selectionId' | 'observedAt' | 'loadState'
>;

export interface ApiRuntimeStatusInput {
  /** The identity this call was prepared with and is dispatching on. */
  readonly identity: Readonly<{ contextKey: string; selectionId: string }>;
  /** The observation the admission took; absent when the provider has no probe. */
  readonly observation?: ApiRuntimeObservation | undefined;
  readonly signals: readonly ApiRuntimeSignal[];
}

/**
 * The waiting state of one API call, or `null` when there is none to publish:
 * nothing was dispatched, or the observation in hand is bound to a different
 * selection than the one dispatching. Browsing a catalog, checking readiness
 * and resuming a run all observe without dispatching, so none of them shows a
 * call as waiting. `settled` is terminal — a chunk recorded after a
 * cancellation or a deadline cannot move the phase back.
 */
export function deriveApiRuntimeStatus(input: ApiRuntimeStatusInput): ApiRuntimeStatus | null {
  const { identity, observation, signals } = input;
  if (!signals.includes('dispatched')) return null;
  if (
    observation !== undefined &&
    (observation.contextKey !== identity.contextKey ||
      observation.selectionId !== identity.selectionId)
  ) {
    return null;
  }

  const phase: ApiRuntimePhase = signals.includes('settled')
    ? 'finished'
    : signals.includes('chunk')
      ? 'streaming'
      : 'waiting-first-response';

  return {
    phase,
    loadState: observation?.loadState ?? 'unknown',
    ...(observation !== undefined && { observedAt: observation.observedAt }),
  };
}
