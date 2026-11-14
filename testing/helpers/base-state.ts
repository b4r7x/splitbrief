import type { WorkflowState } from '../../src/core/schemas/workflow/state.js';
import { createInitialState } from '../../src/core/state/machine.js';

export function baseState(): WorkflowState {
  return createInitialState('feature');
}
