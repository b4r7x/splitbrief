import type { EventBus } from '../../events/types.js';
import type { Phase } from '../../../core/schemas/enums.js';
import type { WorkflowState } from '../../../core/schemas/workflow.js';
import type { UserMessageInput } from '../../../core/types/user-input.js';
import type { SteeringPort } from '../../calls/steering.js';

export const MAX_QUEUE_SIZE = 50;

export type QueueHandlerContext = {
  projectDir: string;
  sessionId: string;
  getState: () => WorkflowState | undefined;
  setState: (s: WorkflowState) => void;
  bus: EventBus;
  steering?: SteeringPort;
};

export interface EnqueueUserMessageOptions {
  projectDir: string;
  sessionId: string;
  state: WorkflowState;
  message: UserMessageInput;
  phase: Phase;
  bus: EventBus;
  /** The run pass has REVIEW None: its final-review phase only rechecks the merged result. */
  reviewNone: boolean;
  enforcePhasePolicy?: boolean | undefined;
  steerable?: boolean | undefined;
}

export interface QueueStateMutationOptions {
  projectDir: string;
  sessionId: string;
  state: WorkflowState;
  bus: EventBus;
}
