import type { SessionRef } from '../../core/types/session-ref.js';
import {
  loadOwnerWorkflowState,
  type OwnedResumeState,
} from '../../core/state/resume-hydration.js';
import { toErrorMessage } from '../../utils/format-errors.js';

export type ResumeHydration = OwnedResumeState;

/**
 * The owner loader classifies the file, so a malformed or newer-version
 * `state.json` reports `invalid` with its reason instead of collapsing into
 * `missing` and leaving the screen blank.
 */
export function hydrateResume(ref: SessionRef): ResumeHydration {
  try {
    return loadOwnerWorkflowState(ref);
  } catch (cause) {
    return { kind: 'invalid', code: 'malformed', message: toErrorMessage(cause) };
  }
}

export function resumeFailureMessage(
  result: Extract<ResumeHydration, { kind: 'invalid' }>,
): string {
  return `Cannot resume: ${result.message}`;
}
