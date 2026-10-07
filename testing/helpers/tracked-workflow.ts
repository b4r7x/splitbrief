import type { Summary } from '../../src/core/schemas/summary.js';
import type { RunWorkflowOptions } from '../../src/engine/orchestrator/run/init.js';

const trackedWorkflows = new Map<AbortController, Promise<Summary>>();

export function runTrackedWorkflow(opts: RunWorkflowOptions): Promise<Summary> {
  return trackWorkflow(async (options) => {
    const { runWorkflow } = await import('../../src/engine/orchestrator/run/workflow.js');
    return runWorkflow(options);
  }, opts);
}

export function trackWorkflow(
  run: (opts: RunWorkflowOptions) => Promise<Summary>,
  opts: RunWorkflowOptions,
): Promise<Summary> {
  const controller = new AbortController();
  const signal =
    opts.signal === undefined
      ? controller.signal
      : AbortSignal.any([opts.signal, controller.signal]);
  const workflow = run({ ...opts, signal });
  trackedWorkflows.set(controller, workflow);
  void workflow.then(
    () => trackedWorkflows.delete(controller),
    () => trackedWorkflows.delete(controller),
  );
  return workflow;
}

export async function settleTrackedWorkflows(): Promise<void> {
  const runs = [...trackedWorkflows];
  for (const [controller] of runs) controller.abort();
  await Promise.allSettled(runs.map(([, run]) => run));
  for (const [controller] of runs) trackedWorkflows.delete(controller);
}
