import type { SessionRef } from '../../core/types/session-ref.js';
import type { WorkflowState } from '../../core/schemas/workflow.js';
import type { ResumeLoadAuthority, StateAuthorityReceipt } from '../../core/state/types.js';
import {
  acquireStateAuthority,
  assertStateAuthority,
  readStateAuthority,
} from '../../core/state/authority.js';
import { loadStateForResume } from '../../core/state/resume-authority.js';
import { error } from '../../utils/error.js';

export type ResumeHydration =
  | Readonly<{
      kind: 'loaded';
      state: WorkflowState;
      authority: StateAuthorityReceipt;
    }>
  | Readonly<{ kind: 'missing' }>
  | Readonly<{
      kind: 'invalid';
      code: 'malformed' | 'future-version';
      message: string;
    }>;

function fencedAuthority(
  receipt: StateAuthorityReceipt,
): Extract<ResumeLoadAuthority, { kind: 'fenced' }> {
  return { kind: 'fenced', receipt, promotedFromVersion: null };
}

function resolveResumeAuthority(
  ref: SessionRef,
  supplied: StateAuthorityReceipt | undefined,
): ResumeLoadAuthority {
  if (supplied !== undefined) {
    assertStateAuthority({ ref, receipt: supplied });
    return fencedAuthority(supplied);
  }

  const observed = readStateAuthority(ref);
  if (observed !== null) {
    try {
      assertStateAuthority({ ref, receipt: observed });
      return fencedAuthority(observed);
    } catch {
      // A dead owner is eligible for the normal authority takeover below.
    }
  }

  const acquired = acquireStateAuthority({ ref, purpose: 'resume' });
  if (acquired.kind === 'new-workflow') {
    throw error(
      'state-authority-invalid',
      'A resume operation cannot consume a new-workflow authority candidate.',
    );
  }
  return acquired;
}

export function hydrateResume(
  ref: SessionRef,
  supplied: StateAuthorityReceipt | undefined,
): ResumeHydration {
  const authority = resolveResumeAuthority(ref, supplied);
  const result = loadStateForResume({ ref, authority });
  if (result.kind === 'loaded') {
    if (authority.kind !== 'fenced') {
      return {
        kind: 'invalid',
        code: 'malformed',
        message: 'A read-only resume permit cannot authorize a loaded workflow state.',
      };
    }
    return { kind: 'loaded', state: result.state, authority: authority.receipt };
  }
  if (result.kind === 'missing') return { kind: 'missing' };
  return { kind: 'invalid', code: result.code, message: result.message };
}

export function resumeFailureMessage(
  result: Extract<ResumeHydration, { kind: 'invalid' }>,
): string {
  return `Cannot resume: ${result.message}`;
}
