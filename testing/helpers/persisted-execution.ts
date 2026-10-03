import { TASKS_FILE } from '../../src/core/paths.js';
import { readSpecFile, writeSpecFile } from '../../src/core/paths-io.js';
import type { SessionRef } from '../../src/core/types/session-ref.js';
import type { WorkflowState } from '../../src/core/schemas/workflow.js';
import { saveState } from '../../src/core/state/persistence.js';
import { formatTasks } from '../../src/engine/spec/formatter.js';
import { parseTasksStrict } from '../../src/engine/spec/tasks/parse.js';
import { readWorkflowStateHead } from '../../src/engine/orchestrator/state-ops.js';

/**
 * Persist a task-run fixture through the same artifact boundary as a resumed
 * workflow. The task bytes are reparsed before the state is materialized, so
 * tests cannot accidentally rely on an in-memory-only ready state.
 */
export function persistReadyExecutionState(ref: SessionRef, state: WorkflowState): WorkflowState {
  saveState(ref, state);

  writeSpecFile(ref, TASKS_FILE, formatTasks(state.tasks), null);
  const tasksText = readSpecFile(ref, TASKS_FILE);
  if (tasksText === null) throw new Error('expected the canonical tasks.md fixture');
  const persistedTasks = parseTasksStrict(tasksText);

  const restored = {
    ...state,
    tasks: persistedTasks.map((task, index) => ({
      ...task,
      status: state.tasks[index]?.status ?? task.status,
      ...(state.tasks[index]?.currentCode === undefined
        ? {}
        : { currentCode: state.tasks[index].currentCode }),
    })),
  } satisfies WorkflowState;
  saveState(ref, restored);
  const head = readWorkflowStateHead(ref);
  if (head === null) throw new Error('expected the canonical owner state head');
  return head.state;
}
