import type {
  acquireStateAuthority,
  releaseStateAuthority,
} from '../../../src/core/state/authority.js';
import type { loadStateForResume } from '../../../src/core/state/resume-authority.js';
import type { WorkflowState } from '../../../src/core/schemas/workflow.js';
import type { StateAuthorityReceipt } from '../../../src/core/state/types.js';
import type { SessionRef } from '../../../src/core/types/session-ref.js';

export function makeStateAuthorityReceipt(
  sessionId: string,
  overrides: Partial<StateAuthorityReceipt> = {},
): StateAuthorityReceipt {
  return {
    kind: 'usable',
    sessionId,
    ownerId: 'test-owner',
    pid: process.pid,
    processStart: 'test-process-start',
    runId: 'test-run',
    acquisitionId: 'test-acquisition',
    fence: 1,
    stateRevision: 0,
    stateDigest: 'test-digest',
    ...overrides,
  };
}

export type ResumeAuthorityDeps = {
  loadStateForResume: typeof loadStateForResume;
  acquireStateAuthority: typeof acquireStateAuthority;
  releaseStateAuthority: typeof releaseStateAuthority;
};

export function makeResumeAuthorityDeps(
  load: (ref: SessionRef) => WorkflowState | null,
): ResumeAuthorityDeps {
  return {
    acquireStateAuthority: (input) => ({
      kind: 'fenced',
      receipt: makeStateAuthorityReceipt(input.ref.sessionId),
      promotedFromVersion: null,
    }),
    loadStateForResume: (input) => {
      const state = load(input.ref);
      return state === null ? { kind: 'missing' } : { kind: 'loaded', state, migrated: false };
    },
    releaseStateAuthority: () => true,
  };
}
