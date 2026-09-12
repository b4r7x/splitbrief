import type { EventBus } from '../../events/types.js';
import type { Phase } from '../../../core/schemas/enums.js';
import type { WorkflowState } from '../../../core/schemas/workflow.js';

export const MAX_QUEUE_SIZE = 50;

export type QueueHandlerContext = {
  projectDir: string;
  sessionId: string;
  getState: () => WorkflowState | undefined;
  setState: (s: WorkflowState) => void;
  bus: EventBus;
};

export interface EnqueueUserMessageOptions {
  projectDir: string;
  sessionId: string;
  state: WorkflowState;
  text: string;
  phase: Phase;
  bus: EventBus;
  enforcePhasePolicy?: boolean | undefined;
}

export interface QueueStateMutationOptions {
  projectDir: string;
  sessionId: string;
  state: WorkflowState;
  bus: EventBus;
}
