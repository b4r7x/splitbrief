import { error } from '../../utils/error.js';
import { REVIEW_FILE, REVIEW_JSON_FILE } from '../paths.js';
import { readSpecFile, rewriteSpecFile } from '../sessions/spec-files.js';
import type { WorkflowState } from '../schemas/workflow/state.js';
import { ReviewRecordSchema, type ReviewRecord } from '../schemas/workflow/review-record.js';
import type { SessionRef } from '../types/session-ref.js';
import { renderReviewMarkdown, type AcceptedReview } from './render.js';
import { reviewOutcomeOf, setAsideInputs } from './verdict.js';
import { recordedFixWork } from './accepted.js';

export function parseReviewRecord(text: string): ReviewRecord {
  try {
    return ReviewRecordSchema.parse(JSON.parse(text));
  } catch (cause) {
    throw error('invalid-typed-review', 'Invalid typed review in review.json', {}, cause);
  }
}

export function readReviewRecord(ref: {
  projectDir: string;
  sessionId: string;
}): ReviewRecord | null {
  const text = readSpecFile(ref, REVIEW_JSON_FILE);
  return text === null ? null : parseReviewRecord(text);
}

export function readFinalReviewRecord(
  ref: SessionRef,
): { kind: 'final'; record: ReviewRecord } | { kind: 'task-only' } | { kind: 'none' } {
  const record = readReviewRecord(ref);
  if (record === null) return { kind: 'none' };
  return record.scope === 'task' ? { kind: 'task-only' } : { kind: 'final', record };
}

/**
 * The one writer of `review.md` after an Accept as is, yours or the planner's: the page of
 * `review` with the accept under its findings, below the frontmatter the file has. `state` is the
 * state before the accept, which still holds the inputs the reviewer set aside.
 */
export function writeAcceptedReview(
  ref: SessionRef,
  state: WorkflowState,
  review: ReviewRecord,
  accepted: AcceptedReview,
): void {
  rewriteSpecFile(
    ref,
    REVIEW_FILE,
    renderReviewMarkdown(
      review.verdict,
      state.tasks,
      reviewOutcomeOf(review),
      review.preExistingChecks ?? [],
      setAsideInputs(state.pendingTriage?.inputs ?? [], recordedFixWork(state, review.at)),
      accepted,
    ),
  );
}
