import { z } from 'zod';
import type { ApprovalReviewResult } from '../approval/types.js';
import { TaskIdSchema } from './task.js';

export const BRIEF_REVIEW_COMMAND_ACTIONS = [
  'approve',
  'reject',
  'revise',
  'save_draft',
  'external_edit_applied',
  'status',
] as const;

export type BriefReviewCommandAction = (typeof BRIEF_REVIEW_COMMAND_ACTIONS)[number];

export const BRIEF_REVIEW_PROMPT_KINDS = ['spec', 'plan', 'briefs', 'artifact'] as const;

export const BriefReviewPromptKindSchema = z.enum(BRIEF_REVIEW_PROMPT_KINDS);

export type BriefReviewPromptKind = z.infer<typeof BriefReviewPromptKindSchema>;

const BriefReviewCommentSchema = z
  .string()
  .trim()
  .min(1)
  .max(256 * 1024);

export const BriefReviewCommandSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('approve') }),
  z.object({ action: z.literal('reject') }),
  z.object({
    action: z.literal('revise'),
    comment: BriefReviewCommentSchema,
    taskIds: z.array(TaskIdSchema).min(1).optional(),
  }),
  z.object({ action: z.literal('save_draft') }),
  z.object({ action: z.literal('external_edit_applied') }),
  z.object({ action: z.literal('status') }),
]);

export type BriefReviewCommand = z.infer<typeof BriefReviewCommandSchema>;

export type BriefReviewCommandDisposition =
  | { kind: 'settles'; result: ApprovalReviewResult }
  | { kind: 'save-draft' }
  | { kind: 'status' };

export function allowedBriefReviewCommandsForPrompt(
  promptKind: BriefReviewPromptKind,
): readonly BriefReviewCommandAction[] {
  return promptKind === 'briefs' ? BRIEF_REVIEW_COMMAND_ACTIONS : [];
}

export function allowedSettlingBriefReviewCommandsForPrompt(
  promptKind: BriefReviewPromptKind,
): readonly BriefReviewCommandAction[] {
  return allowedBriefReviewCommandsForPrompt(promptKind).filter((action) => {
    return action !== 'save_draft' && action !== 'status';
  });
}

export function isBriefReviewCommandAllowedForPrompt(
  command: BriefReviewCommand,
  promptKind: BriefReviewPromptKind,
): boolean {
  return allowedBriefReviewCommandsForPrompt(promptKind).some(
    (action) => action === command.action,
  );
}

export function briefReviewCommandToApprovalReviewResult(
  command: BriefReviewCommand,
): ApprovalReviewResult | null {
  const disposition = briefReviewCommandDisposition(command);
  return disposition.kind === 'settles' ? disposition.result : null;
}

export function briefReviewCommandDisposition(
  command: BriefReviewCommand,
): BriefReviewCommandDisposition {
  switch (command.action) {
    case 'approve':
      return { kind: 'settles', result: { approved: true } };
    case 'reject':
      return { kind: 'settles', result: { approved: false } };
    case 'revise':
      return {
        kind: 'settles',
        result: {
          approved: false,
          action: 'revise',
          comment: command.comment,
          ...(command.taskIds !== undefined && { taskIds: command.taskIds }),
        },
      };
    case 'external_edit_applied':
      return { kind: 'settles', result: { approved: false, action: 'edit' } };
    case 'save_draft':
      return { kind: 'save-draft' };
    case 'status':
      return { kind: 'status' };
    default: {
      const exhaustive: never = command;
      return exhaustive;
    }
  }
}
