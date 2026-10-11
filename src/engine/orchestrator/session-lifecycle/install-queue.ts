import type { Config } from '../../../core/schemas/config.js';
import type { WorkflowState } from '../../../core/schemas/workflow.js';
import type { EventBus } from '../../events/types.js';
import { createQueueHandler } from '../queue/submit.js';
import { createClearQueueHandler } from '../queue/clear.js';
import { createWriteSequencer } from '../serial-executor.js';
import type { Planner } from '../../planners/types.js';
import type { WorkflowContext, WorkflowSinks } from '../types.js';
import type { SteeringPort } from '../../calls/steering.js';

export type InstallQueueHandlerOpts = Pick<WorkflowContext, 'modelCache'> & {
  projectDir: string;
  sessionId: string;
  sinks: WorkflowSinks;
  getTrackedState: () => WorkflowState | undefined;
  setTrackedState: (s: WorkflowState) => void;
  bus: EventBus;
  config: Config;
  planner: Planner;
  steering: SteeringPort;
  signal?: AbortSignal | undefined;
};

export function installQueueHandler(opts: InstallQueueHandlerOpts): void {
  const serialize = createWriteSequencer();
  opts.sinks.setQueueHandler(
    createQueueHandler({
      projectDir: opts.projectDir,
      sessionId: opts.sessionId,
      getState: opts.getTrackedState,
      setState: opts.setTrackedState,
      bus: opts.bus,
      config: opts.config,
      modelCache: opts.modelCache,
      planner: opts.planner,
      serialize,
      steering: opts.steering,
      ...(opts.signal !== undefined && { signal: opts.signal }),
    }),
  );
  opts.sinks.setClearQueueHandler?.(
    createClearQueueHandler({
      projectDir: opts.projectDir,
      sessionId: opts.sessionId,
      getState: opts.getTrackedState,
      setState: opts.setTrackedState,
      bus: opts.bus,
      serialize,
    }),
  );
}
