import { addEvent } from '../../stores/workflow/actions/event.js';
import type { EngineEvent } from '../../engine/events/types.js';
import { boundEngineEventForConsumer } from '../../engine/events/bound.js';

export function addTuiEvent(event: EngineEvent): void {
  addEvent(boundEngineEventForConsumer(event, 'tui'));
}
