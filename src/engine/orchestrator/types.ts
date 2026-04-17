import type { Config } from '../../core/types/config-options.js';
import type { OrchestratorCallbacks } from '../../core/types/events.js';
import type { Phase, ProjectContext } from '../../core/types/state-actions.js';
import type { Planner, PriorMessage } from '../planners/types.js';
import type { Implementer } from '../implementers/types.js';
import type { SpecMetadata } from '../../core/paths-io.js';

export interface ResumeContextHolder {
  messages: PriorMessage[];
}

export type QueueHandler = (text: string, phase: Phase) => void;

export interface WorkflowSinks {
  setAbortHandler: (handler: (() => void) | null) => void;
  setQueueHandler: (handler: QueueHandler | null) => void;
}

export interface WorkflowContext {
  projectDir: string;
  sessionId: string;
  config: Config;
  callbacks: OrchestratorCallbacks;
  planner: Planner;
  context: ProjectContext;
  implementer: Implementer;
  signal?: AbortSignal | undefined;
  metadata: SpecMetadata;
  resumeHolder?: ResumeContextHolder | undefined;
  sinks: WorkflowSinks;
}

export type PlannerCallbacksContext = Pick<WorkflowContext, 'projectDir' | 'sessionId' | 'config' | 'callbacks' | 'signal' | 'metadata' | 'resumeHolder' | 'sinks'>;
