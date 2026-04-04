import type { Config, OrchestratorCallbacks, ProjectContext } from '../../types.js';
import type { PlannerBackend } from '../planners/types.js';
import type { ImplementerBackend } from '../implementers/types.js';

export interface WorkflowContext {
  projectDir: string;
  config: Config;
  callbacks: OrchestratorCallbacks;
  planner: PlannerBackend;
  context: ProjectContext;
  implementer: ImplementerBackend;
}
