import { PhaseSchema, type Phase } from './schemas/enums.js';

export function eventPhase(event: object): Phase | undefined {
  if (!('phase' in event)) return undefined;
  const result = PhaseSchema.safeParse((event as { phase?: unknown }).phase);
  return result.success ? result.data : undefined;
}

export const INFRASTRUCTURE_PHASE_EVENT_TYPES = ['replay_started', 'replay_complete'] as const;

export type EventTypeCarrier = { readonly type: string };

const infrastructurePhaseEventTypes = new Set<string>(INFRASTRUCTURE_PHASE_EVENT_TYPES);

export function isInfrastructurePhaseEvent(event: EventTypeCarrier): boolean {
  return infrastructurePhaseEventTypes.has(event.type);
}

/** The replay end of a reopened run whose process went away mid-step: what it ran then never finished. */
export function isProcessWentAwayMark(event: EventTypeCarrier): boolean {
  return (
    event.type === 'replay_complete' && 'processWentAway' in event && event.processWentAway === true
  );
}
