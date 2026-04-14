import type { Config, OrchestratorCallbacks, ProjectContext } from '../../types.js';
import type { Planner } from '../planners/types.js';
import type { Implementer } from '../implementers/types.js';
import type { SpecMetadata } from '../../core/paths-io.js';

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
}

export type PlannerCallbacksContext = Pick<WorkflowContext, 'projectDir' | 'sessionId' | 'config' | 'callbacks' | 'signal' | 'metadata'>;
