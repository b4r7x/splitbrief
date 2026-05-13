import type { WorkflowMode } from '../../src/core/schemas/enums.js';
import type { SpecMetadata } from '../../src/core/paths-io.js';
import type { WorkflowSinks } from '../../src/engine/orchestrator/types.js';

export const TEST_WORKFLOW_SINKS: WorkflowSinks = {
  setAbortHandler: () => {},
  setQueueHandler: () => {},
};

export function makeWorkflowMetadata(mode: WorkflowMode = 'standard'): SpecMetadata {
  return { plannerTool: 'claude-code', implementerTool: 'ollama', mode };
}
