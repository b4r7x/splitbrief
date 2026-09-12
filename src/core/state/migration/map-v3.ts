import { WORKFLOW_STATE_VERSION, WorkflowStateSchema } from '../../schemas/workflow.js';
import type { WorkflowState } from '../../schemas/workflow.js';
import type { SessionRef } from '../../types/session-ref.js';
import { legacyWorkflowStateSchema, type LegacyWorkflowState } from './legacy-state.js';

export type LegacyStateMigrationInput = Readonly<{
  ref: SessionRef;
  state: LegacyWorkflowState;
  stateRevision: number;
}>;

/**
 * Pure v3 → v4 conversion. No authority acquisition or filesystem read belongs
 * here; callers provide the already-read legacy state. Returns null when the
 * legacy state or its migrated form fails validation.
 */
export function mapV3StateToV4(input: LegacyStateMigrationInput): WorkflowState | null {
  const parsedState = legacyWorkflowStateSchema.safeParse(input.state);
  if (!parsedState.success) return null;
  const migrated = {
    ...parsedState.data,
    stateVersion: WORKFLOW_STATE_VERSION,
    stateRevision: input.stateRevision,
  };
  const result = WorkflowStateSchema.safeParse(migrated);
  return result.success ? result.data : null;
}
