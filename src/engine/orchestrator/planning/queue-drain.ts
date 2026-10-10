import type { WorkflowState, QueuedMessage } from '../../../core/schemas/workflow.js';
import type { EventBus } from '../../events/types.js';
import { drainQueue } from '../queue/drain.js';
import { formatDrainedMessages } from '../queue/prompt.js';
import { settleMidCallDeliveries } from '../queue/mid-call.js';

export async function drainAndFormat(
  projectDir: string,
  sessionId: string,
  state: WorkflowState,
  bus: EventBus,
): Promise<{ state: WorkflowState; prefix: string; messages: QueuedMessage[] }> {
  await settleMidCallDeliveries({ projectDir, sessionId });
  const drain = drainQueue({ projectDir, sessionId, state, bus, seat: 'plan' });
  return {
    state: drain.state,
    prefix: formatDrainedMessages(drain.messages),
    messages: drain.messages,
  };
}
