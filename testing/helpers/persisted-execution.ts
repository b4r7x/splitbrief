import { TASKS_FILE } from '../../src/core/paths.js';
import { writeSpecFile } from '../../src/core/paths-io.js';
import type { SessionRef } from '../../src/core/types/session-ref.js';
import type { WorkflowState } from '../../src/core/schemas/workflow.js';
import { saveState } from '../../src/core/state/persistence.js';
import { formatTasks } from '../../src/engine/spec/formatter.js';
import { readWorkflowStateHead } from '../../src/engine/orchestrator/state-ops.js';

/**
 * Persist a task-run fixture the way a planned run leaves it — `state.json` and its `tasks.md`
 * projection — and return the state read back, so tests cannot rely on an in-memory-only state.
 */
export function persistReadyExecutionState(ref: SessionRef, state: WorkflowState): WorkflowState {
  saveState(ref, state);
  writeSpecFile(ref, TASKS_FILE, formatTasks(state.tasks), null);
  const head = readWorkflowStateHead(ref);
  if (head === null) throw new Error('expected the canonical owner state head');
  return head.state;
}
