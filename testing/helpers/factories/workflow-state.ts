import type { Task } from '../../../src/core/schemas/task.js';
import {
  LineageRecordSchema,
  type LineageRecord,
  type WorkflowState,
} from '../../../src/core/schemas/workflow.js';
import { BOUNDS } from '../../../src/core/pipeline-spec/bounds.js';
import { createInitialState, transition } from '../../../src/core/state/machine.js';

export function makeImplState(tasks: Task[], overrides?: Partial<WorkflowState>): WorkflowState {
  let state = createInitialState('feat');
  state = transition(state, { type: 'START' });
  state = { ...state, tasks };
  state = transition(state, { type: 'BEGIN_IMPLEMENTATION' });
  return { ...state, ...overrides };
}

/** A lineage that got every planner answer it may get: its next judgement halts on no progress. */
export function spentAnswersLineage(overrides: Partial<LineageRecord> = {}): LineageRecord {
  return {
    ...LineageRecordSchema.parse({ attempts: 0 }),
    progress: { failure: [], unmoved: 0, answers: BOUNDS.answersPerBrief },
    ...overrides,
  };
}

export function makeImplStateWithMetadata(
  tasks: Task[],
  overrides?: Partial<WorkflowState>,
): WorkflowState {
  return makeImplState(tasks, {
    implementerTool: 'ollama',
    implementerModel: 'qwen2.5',
    plannerTool: 'claude-code',
    ...overrides,
  });
}

export function makeLegacyV3State(feature = 'legacy-feature'): WorkflowState {
  return {
    ...createInitialState(feature),
    stateVersion: 3,
    phase: 'reviewing-briefs',
    currentTaskIndex: 0,
    tasks: [],
    mode: 'standard',
    messageQueue: [],
  };
}

/** A saved state at one phase; the fields a display test reads and nothing else invented. */
export function makeWorkflowState(overrides: Partial<WorkflowState> = {}): WorkflowState {
  return { ...createInitialState('feat'), ...overrides };
}

/** The seats a started run saves in its state; a run that closes names them. */
export const RUN_CREW = { plannerTool: 'claude-code', implementerTool: 'codex' } as const;
