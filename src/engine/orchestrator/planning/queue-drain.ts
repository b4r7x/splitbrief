import type { WorkflowState, QueuedMessage } from '../../../core/schemas/workflow.js';
import type { EventBus } from '../../events/types.js';
import { drainQueue } from '../queue/drain.js';
import { formatDrainedMessages } from '../queue/prompt.js';

export function drainAndFormat(
  projectDir: string,
  sessionId: string,
  state: WorkflowState,
  bus: EventBus,
): { state: WorkflowState; prefix: string; messages: QueuedMessage[] } {
  const drain = drainQueue({ projectDir, sessionId, state, bus });
  return {
    state: drain.state,
    prefix: formatDrainedMessages(drain.messages),
    messages: drain.messages,
  };
}
