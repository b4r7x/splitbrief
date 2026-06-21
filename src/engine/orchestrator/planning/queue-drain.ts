import type { WorkflowState } from '../../../core/schemas/workflow.js';
import type { EventBus } from '../../events/types.js';
import { drainQueue, formatDrainedMessages } from '../queue.js';

export function drainAndFormat(
  projectDir: string,
  sessionId: string,
  state: WorkflowState,
  bus: EventBus,
): { state: WorkflowState; prefix: string } {
  const drain = drainQueue({ projectDir, sessionId, state, bus });
  if (drain.messages.length === 0) return { state, prefix: '' };
  return { state: drain.state, prefix: formatDrainedMessages(drain.messages) };
}
