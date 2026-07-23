import type { Config } from '../../../core/schemas/config.js';
import type { WorkflowState } from '../../../core/schemas/workflow.js';
import type { EventBus } from '../../events/types.js';
import { createQueueHandler } from '../queue/submit.js';
import { createClearQueueHandler } from '../queue/clear.js';
import { createWriteSequencer } from '../serial-executor.js';
import type { Planner } from '../../planners/types.js';
import type { WorkflowSinks } from '../types.js';

export type InstallQueueHandlerOpts = {
  projectDir: string;
  sessionId: string;
  sinks: WorkflowSinks;
  getTrackedState: () => WorkflowState | undefined;
  setTrackedState: (s: WorkflowState) => void;
  bus: EventBus;
  config: Config;
  planner: Planner;
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
      persistTranscript: opts.config.workflow.persistTranscript,
      planner: opts.planner,
      serialize,
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
