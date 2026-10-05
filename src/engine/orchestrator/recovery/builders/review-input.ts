import type { Phase } from '../../../../core/schemas/enums.js';
import type { RecoveryIssue } from '../../../../core/schemas/recovery/schemas.js';
import type { FinalReviewFailure } from '../../final-review.js';
import { orderedActions } from './actions.js';
import { compactFacts, createRecoveryIssue, type RecoveryBuilderBase } from './issue.js';

export function inputTooLargeSentence(
  subject: string,
  figures: { chars: number; maxChars: number | null },
  tool: string,
): string {
  const { chars, maxChars } = figures;
  return `${subject} is ${chars.toLocaleString('en-US')} characters; ${tool} ${
    maxChars === null
      ? 'refused it as too large'
      : `takes at most ${maxChars.toLocaleString('en-US')}`
  }`;
}

export function reviewInputTooLargeMessage(
  failure: Extract<FinalReviewFailure, { kind: 'input-too-large' }>,
  tool: string,
): string {
  return inputTooLargeSentence('Review input', failure, tool);
}

export function buildReviewInputTooLargeRecoveryIssue(
  opts: RecoveryBuilderBase & {
    phase: Phase;
    failure: Extract<FinalReviewFailure, { kind: 'input-too-large' }>;
    tool: string;
    acceptAsIs: boolean;
  },
): RecoveryIssue {
  const { chars, maxChars, largestFiles } = opts.failure;
  return createRecoveryIssue({
    id: opts.id,
    reason: 'review-input-too-large',
    seat: 'review',
    phase: opts.phase,
    files: [],
    affectedTaskIds: [],
    message: reviewInputTooLargeMessage(opts.failure, opts.tool),
    details: [
      `Largest diffs: ${largestFiles.map((file) => `${file.path} (${file.chars.toLocaleString('en-US')} chars)`).join(', ')}`,
      'A retry sends the same input. Skip the review with a note (recorded, not a verification) or End the run (a workspace run saves its changes in run.patch).',
    ],
    facts: compactFacts({ tool: opts.tool, chars, maxChars: maxChars ?? undefined }),
    availableActions: orderedActions([opts.acceptAsIs ? 'accept-as-is' : undefined, 'end-run']),
    recommendedAction: 'end-run',
    createdAt: opts.createdAt,
  });
}
