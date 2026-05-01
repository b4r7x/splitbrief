import * as actions from '../../stores/workflow/actions.js';
import type { EventSink } from '../../engine/events/types.js';

/**
 * Forwards EngineEvent from the bus into the workflow store so Ink renderers
 * observe it via store subscriptions. The workflow sub-stores consume
 * EngineEvent directly — this sink is a thin, named wiring point, not a mapper.
 */
export function createTuiSink(): EventSink {
  return actions.addEvent;
}
