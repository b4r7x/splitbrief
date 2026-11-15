import type { WorkflowState } from '../../../core/schemas/workflow/state.js';
import type { WorkflowContext } from '../types.js';
import type { ApplyStates } from './states.js';

export type ApplyInput = {
  wctx: Pick<WorkflowContext, 'projectDir' | 'sessionId' | 'bus'>;
  state: WorkflowState;
  reviewNone: boolean;
  setTrackedState?: ((state: WorkflowState) => void) | undefined;
  overrideConfirmed?: boolean | undefined;
};

export type ApplyResult =
  | { outcome: 'applied'; state: WorkflowState; files: string[] }
  | { outcome: 'halted'; state: WorkflowState }
  | { outcome: 'restored'; state: WorkflowState; files: string[] }
  | { outcome: 'review'; state: WorkflowState }
  | { outcome: 'needs-confirmation'; state: WorkflowState };

/** What the steps of one Apply read and never change, from the capture of its three states on. */
export type ApplyRun = Pick<ApplyInput, 'wctx' | 'reviewNone' | 'setTrackedState'> & {
  workspace: NonNullable<WorkflowState['workspace']>;
  states: ApplyStates;
};

/**
 * The workflow state that the steps of one Apply pass on. Each step changes it in place, so the
 * result of Apply holds the state that the last step left.
 */
export type ApplyState = { state: WorkflowState };
