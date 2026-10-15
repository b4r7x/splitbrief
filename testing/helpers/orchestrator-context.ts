import type { SpecMetadata } from '../../src/core/paths-io.js';
import type { WorkflowSinks } from '../../src/engine/orchestrator/types.js';

export const TEST_WORKFLOW_SINKS: WorkflowSinks = {
  setAbortHandler: () => {},
  setQueueHandler: () => {},
};

export function makeWorkflowMetadata(): SpecMetadata {
  return {
    planner: 'Claude Code CLI · auto',
    implementer: 'Ollama · auto',
    reviewer: 'Claude Code CLI · auto',
  };
}
