import type { Task, TaskId } from '../../core/schemas/task.js';
import type { WorkflowMode } from '../../core/schemas/enums.js';
import type { HandoffTarget } from '../../core/handoff/targets.js';

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
