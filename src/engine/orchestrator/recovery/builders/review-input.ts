import type { Phase } from '../../../../core/schemas/enums.js';
import type { RecoveryIssue } from '../../../../core/schemas/recovery/schemas.js';
import type { FinalReviewFailure } from '../../final-review.js';
import type { PromptSize } from '../../../runners/input-limit.js';
import { haltActions } from './actions.js';
import { compactFacts, createRecoveryIssue, type RecoveryBuilderBase } from './issue.js';

/**
 * A too-large prompt in SPLITBRIEF's words: its size and the tool's limit where the refusal
 * named them, never a figure it did not name. Bytes are the command line's limit.
 */
export function inputTooLargeSentence(subject: string, figures: PromptSize, tool: string): string {
  const { unit, size, limit } = figures;
  const where = unit === 'bytes' ? ' on its command line' : '';
  if (size === null) {
    return limit === null
      ? `${subject} is too large for ${tool}`
      : `${subject} is larger than the ${limit.toLocaleString('en-US')} ${unit} ${tool} takes${where}`;
  }
  return `${subject} is ${size.toLocaleString('en-US')} ${unit}; ${tool} ${
    limit === null
      ? 'refused it as too large'
      : `takes at most ${limit.toLocaleString('en-US')}${where}`
  }`;
}

/** The facts a halt keeps for a too-large prompt, named by the unit the refusal counted. */
export function inputTooLargeFacts({
  unit,
  size,
  limit,
}: PromptSize): Record<string, number | undefined> {
  return unit === 'bytes'
    ? { bytes: size ?? undefined, maxBytes: limit ?? undefined }
    : { chars: size ?? undefined, maxChars: limit ?? undefined };
}

export function reviewInputTooLargeMessage(
  failure: Extract<FinalReviewFailure, { kind: 'input-too-large' }>,
  tool: string,
): string {
  return inputTooLargeSentence(
    'Review input',
    { unit: 'characters', size: failure.chars, limit: failure.maxChars },
    tool,
  );
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
      opts.acceptAsIs
        ? 'A retry sends the same input. Skip the review with a note (recorded, not a verification) or End the run (a workspace run saves its changes in run.patch).'
        : 'A retry sends the same input. End the run (a workspace run saves its changes in run.patch).',
    ],
    facts: compactFacts({ tool: opts.tool, chars, maxChars: maxChars ?? undefined }),
    availableActions: haltActions('review-input-too-large', [
      opts.acceptAsIs ? 'accept-as-is' : undefined,
      'end-run',
    ]),
    recommendedAction: 'end-run',
    createdAt: opts.createdAt,
  });
}
