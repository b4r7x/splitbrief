import type { Task } from '../../../src/core/schemas/task.js';
import type { WorkflowState } from '../../../src/core/schemas/workflow.js';
import { createInitialState, transition } from '../../../src/core/state/machine.js';

export function makeImplState(tasks: Task[], overrides?: Partial<WorkflowState>): WorkflowState {
  let state = createInitialState('feat');
  state = transition(state, { type: 'START' });
  state = transition(state, { type: 'RESEARCH_DONE' });
  state = transition(state, { type: 'SPEC_DONE' });
  state = transition(state, { type: 'APPROVE_SPEC' });
  state = transition(state, { type: 'PLAN_DONE', tasks });
  state = transition(state, { type: 'BRIEFS_READY', tasks });
  state = transition(state, { type: 'APPROVE_BRIEFS' });
  return { ...state, ...overrides };
}

export function makeImplStateWithMetadata(tasks: Task[]): WorkflowState {
  return makeImplState(tasks, {
    implementerTool: 'ollama',
    implementerModel: 'qwen2.5',
    plannerTool: 'claude-code',
  });
}
