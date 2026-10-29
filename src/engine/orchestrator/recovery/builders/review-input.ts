import { join } from 'node:path';
import type { Phase } from '../../../../core/schemas/enums.js';
import type { RecoveryIssue } from '../../../../core/schemas/recovery/schemas.js';
import type { FinalReviewFailure } from '../../final-review.js';
import { inputTooLargeFacts, inputTooLargeSentence } from '../../../runners/input-limit.js';
import { haltActions } from './actions.js';
import { compactFacts, createRecoveryIssue, type RecoveryBuilderBase } from './issue.js';
import { switchSeatOffer, type SeatSwapContext } from './task.js';

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
  const { figures, promptSize, changeFile, workspaceDir } = opts.failure;
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
      `A retry sends the same input. ${new Intl.ListFormat('en-GB', { type: 'disjunction' }).format(
        [
          switchSeat === undefined ? '' : 'Change the REVIEW tool to one that takes it',
          opts.acceptAsIs ? 'Skip the review with a note (recorded, not a verification)' : '',
          'End the run (a workspace run saves its changes in run.patch)',
        ].filter((choice) => choice !== ''),
      )}.`,
      `The reviewer reads the change from ${changeFile} in the run workspace, not from the prompt; the prompt holds the plan, the briefs and the evidence.${
        figures.limit === null
          ? ` A very large change can also fill the context of ${opts.tool} when it reads that file.`
          : ''
      }`,
    ],
    facts: compactFacts({
      tool: opts.tool,
      ...inputTooLargeFacts(figures),
      changeFile: join(workspaceDir, changeFile),
    }),
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
