import type { z } from 'zod';
import type { EngineEventSchema } from './schema.js';

export type ValidationStages = { typecheck: boolean; lint: boolean; test: boolean };

export type EngineEvent = z.infer<typeof EngineEventSchema>;

export type EngineEventOf<T extends EngineEvent['type']> = Extract<EngineEvent, { type: T }>;

export type EventSink = (event: EngineEvent) => void;

export interface EventBus {
  publish(event: EngineEvent): void;
  subscribe(sink: EventSink): () => void;
  unsubscribeAll(): void;
}
