import type { Phase } from '../../../../core/schemas/enums.js';
import type { RecoveryIssue } from '../../../../core/schemas/recovery/schemas.js';
import type { FinalReviewFailure } from '../../final-review.js';
import type { PromptSize } from '../../../runners/input-limit.js';
import { haltActions } from './actions.js';
import { compactFacts, createRecoveryIssue, type RecoveryBuilderBase } from './issue.js';
import { switchSeatOffer, type SeatSwapContext } from './task.js';

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
  return inputTooLargeSentence('Review input', failure.figures, tool);
}

export function buildReviewInputTooLargeRecoveryIssue(
  opts: RecoveryBuilderBase & {
    phase: Phase;
    failure: Extract<FinalReviewFailure, { kind: 'input-too-large' }>;
    tool: string;
    acceptAsIs: boolean;
    seatSwap?: SeatSwapContext | undefined;
  },
): RecoveryIssue {
  const { figures, promptSize, largestFiles } = opts.failure;
  const switchSeat = switchSeatOffer(opts.seatSwap, promptSize);
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
      `A retry sends the same input. ${new Intl.ListFormat('en-GB', { type: 'disjunction' }).format(
        [
          switchSeat === undefined ? '' : 'Change the REVIEW tool to one that takes it',
          opts.acceptAsIs ? 'Skip the review with a note (recorded, not a verification)' : '',
          'End the run (a workspace run saves its changes in run.patch)',
        ].filter((choice) => choice !== ''),
      )}.`,
    ],
    facts: compactFacts({ tool: opts.tool, ...inputTooLargeFacts(figures) }),
    availableActions: haltActions('review-input-too-large', [
      switchSeat === undefined ? undefined : 'switch-seat',
      opts.acceptAsIs ? 'accept-as-is' : undefined,
      'end-run',
    ]),
    ...(switchSeat !== undefined && { switchSeat }),
    recommendedAction: switchSeat === undefined ? 'end-run' : 'switch-seat',
    createdAt: opts.createdAt,
  });
}
