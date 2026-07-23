import { addEvent } from '../../stores/workflow/actions/event.js';
import type { EventSink } from '../../engine/events/types.js';
import type { EngineEvent } from '../../engine/events/types.js';
import { protectEngineEventForConsumer } from '../../engine/events/protection/protect.js';

export interface TuiSinkOptions {
  persistTranscript?: boolean | undefined;
}

export function addTuiEvent(event: EngineEvent, opts: TuiSinkOptions = {}): void {
  const protectedEvent = protectEngineEventForConsumer(event, {
    context: 'ipc',
    persistTranscript: opts.persistTranscript ?? true,
  });
  if (protectedEvent !== null) addEvent(protectedEvent);
}

export function createTuiSink(opts: TuiSinkOptions = {}): EventSink {
  return (event) => addTuiEvent(event, opts);
}
