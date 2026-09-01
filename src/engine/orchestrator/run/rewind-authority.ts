import type { WorkflowState } from '../../../core/schemas/workflow.js';
import type { ResumeLoadAuthority, StateAuthorityReceipt } from '../../../core/state/types.js';
import { loadStateForResume } from '../../../core/state/resume-authority.js';
import { readWorkflowStateHead } from '../state-ops.js';
import { refreshWorkflowAuthority, type WorkflowAuthorityHolder } from './authority.js';

export const WORKFLOW_REWIND_ABORT_REASON = 'workflow-rewind';

function readHead(ref: { projectDir: string; sessionId: string }): WorkflowState | null {
  try {
    return readWorkflowStateHead(ref)?.state ?? null;
  } catch {
    return null;
  }
}

// A rewind abort unwinds the run while the rewind request itself is already persisted.
// The run's in-memory authority is then behind the state file, so it is re-fenced against
// the persisted head (when that head is still ours) before the state is read back.
export function reconcileRewindAuthority(opts: {
  projectDir: string;
  sessionId: string;
  signal: AbortSignal | undefined;
  authority: StateAuthorityReceipt | undefined;
  holder: WorkflowAuthorityHolder | undefined;
}): { state?: WorkflowState; authority?: StateAuthorityReceipt } {
  if (opts.signal?.reason !== WORKFLOW_REWIND_ABORT_REASON || opts.authority === undefined) {
    return {};
  }
  const ref = { projectDir: opts.projectDir, sessionId: opts.sessionId };
  const holder = opts.holder;
  let authority = opts.authority;
  const adopt = (state: WorkflowState): void => {
    if (holder === undefined) return;
    holder.current = refreshWorkflowAuthority(ref, holder.current, state);
    authority = holder.current;
  };

  const head = readHead(ref);
  const headFence = head?.stateFence;
  let refreshed = false;
  if (
    head !== null &&
    head.rewindPending !== undefined &&
    (head.stateRevision ?? 0) >= authority.stateRevision &&
    headFence?.token === authority.fence &&
    headFence.ownerId === authority.ownerId
  ) {
    adopt(head);
    refreshed = true;
  }

  const resumeAuthority: ResumeLoadAuthority = {
    kind: 'fenced',
    receipt: authority,
    promotedFromVersion: null,
  };
  const loaded = loadStateForResume({ ref, authority: resumeAuthority });
  if (loaded.kind !== 'loaded' || loaded.state.rewindPending === undefined) return { authority };
  if (!refreshed) adopt(loaded.state);
  return { state: loaded.state, authority };
}
