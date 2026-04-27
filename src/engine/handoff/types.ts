import type { Task, TaskId } from '../../core/schemas/task.js';
import type { WorkflowMode } from '../../core/schemas/enums.js';

export type HandoffTarget = 'spec-kit' | 'agents-md' | 'claude-code' | 'copilot-issue';

export const HANDOFF_TARGETS: readonly HandoffTarget[] = [
  'spec-kit',
  'agents-md',
  'claude-code',
  'copilot-issue',
];

export type HandoffInput = {
  target: HandoffTarget;
  sessionId: string;
  feature: string;
  mode: WorkflowMode;
  tasks: Task[];
  selectedTaskIds?: TaskId[];
  spec?: string;
  plan?: string;
  constitution?: string;
  validation?: {
    typecheck?: string;
    lint?: string;
    test?: string;
  };
};

export type HandoffFile = {
  path: string;
  content: string;
};

export type HandoffPack = {
  files: HandoffFile[];
};
