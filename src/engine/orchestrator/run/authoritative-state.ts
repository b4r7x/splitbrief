import type { WorkflowState } from '../../../core/schemas/workflow.js';
import { acquireStateAuthority } from '../../../core/state/authority.js';
import { loadStateForResume } from '../../../core/state/persistence.js';
import type {
  StateAuthorityAcquisitionResult,
  StateAuthorityReceipt,
} from '../../../core/state/types.js';
import { error } from '../../../utils/error.js';
import { consumeNewWorkflowCandidate } from './authority.js';

type AuthoritativeWorkflowState = Readonly<{
  state: WorkflowState;
  authority: StateAuthorityReceipt;
  newWorkflow: boolean;
}>;

function loadedWorkflowState(result: ReturnType<typeof loadStateForResume>): WorkflowState {
  switch (result.kind) {
    case 'loaded':
      return result.state;
    case 'missing':
      throw error('workflow-state-missing', 'No persisted workflow state is available to resume.');
    case 'invalid':
      throw error('workflow-state-invalid', result.message);
    default: {
      const exhaustive: never = result;
      throw error('workflow-state-invalid', `Unknown workflow state result: ${String(exhaustive)}`);
    }
  }
}

export function acquireAuthoritativeWorkflowState(opts: {
  projectDir: string;
  sessionId: string;
  feature: string;
  purpose: 'new-workflow' | 'resume';
}): AuthoritativeWorkflowState {
  const ref = { projectDir: opts.projectDir, sessionId: opts.sessionId };
  const acquired: StateAuthorityAcquisitionResult = acquireStateAuthority({
    ref,
    purpose: opts.purpose,
  });
  let authority: StateAuthorityReceipt;
  let promotedFromVersion: 3 | null = null;
  let newWorkflow = false;
  switch (acquired.kind) {
    case 'fenced':
      authority = acquired.receipt;
      promotedFromVersion = acquired.promotedFromVersion;
      break;
    case 'new-workflow':
      authority = consumeNewWorkflowCandidate(ref, acquired.candidate, opts.feature);
      newWorkflow = true;
      break;
    case 'read-only': {
      const result = loadStateForResume({ ref, authority: acquired });
      switch (result.kind) {
        case 'missing':
          throw error(
            'workflow-state-missing',
            'A read-only authority cannot initialize a workflow.',
          );
        case 'invalid':
          throw error('workflow-state-invalid', result.message);
        case 'loaded':
          throw error('state-authority-invalid', 'A read-only authority cannot load a workflow.');
        default: {
          const exhaustive: never = result;
          throw error(
            'workflow-state-invalid',
            `Unknown workflow state result: ${String(exhaustive)}`,
          );
        }
      }
    }
    default: {
      const exhaustive: never = acquired;
      throw error('state-authority-invalid', `Unknown authority result: ${String(exhaustive)}`);
    }
  }
  const loaded = loadStateForResume({
    ref,
    authority: { kind: 'fenced', receipt: authority, promotedFromVersion },
  });
  return { authority, state: loadedWorkflowState(loaded), newWorkflow };
}
