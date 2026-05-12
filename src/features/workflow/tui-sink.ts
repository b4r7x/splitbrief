import * as actions from '../../stores/workflow/actions.js';
import type { EventSink } from '../../engine/events/types.js';

export function createTuiSink(): EventSink {
  return actions.addEvent;
}
