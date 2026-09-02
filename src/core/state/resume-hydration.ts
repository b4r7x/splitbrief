import type { SessionRef } from '../types/session-ref.js';
import { acquireStateAuthority, releaseStateAuthority } from './authority.js';
import { loadStateForResume } from './resume-authority.js';
import type { ResumeLoadResult } from './types.js';

export type OwnedResumeHydration = ResumeLoadResult & { readonly fenced: boolean };

export function loadOwnerWorkflowState(ref: SessionRef): OwnedResumeHydration {
  let acquired: ReturnType<typeof acquireStateAuthority>;
  try {
    acquired = acquireStateAuthority({ ref, purpose: 'resume' });
  } catch (cause) {
    return {
      kind: 'invalid',
      code: 'malformed',
      message: cause instanceof Error ? cause.message : 'State authority is unavailable.',
      fenced: false,
    };
  }

  if (acquired.kind === 'new-workflow') return { kind: 'missing', fenced: false };
  if (acquired.kind !== 'fenced') {
    return { ...loadStateForResume({ ref, authority: acquired }), fenced: false };
  }
  try {
    return { ...loadStateForResume({ ref, authority: acquired }), fenced: true };
  } finally {
    releaseStateAuthority(ref, acquired.receipt);
  }
}
