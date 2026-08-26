import { z } from 'zod';
import { assertNever } from '../../utils/type-guards.js';
import type { ApprovalReviewResult } from '../approval/types.js';
import {
  type BriefRecoveryProjectionV1,
  BriefRecoveryProjectionV1Schema,
} from './brief-recovery/document.js';
import {
  type RecoveryResult,
  type RecoveryResultV1,
  RecoveryResultV1Schema,
} from './brief-recovery.js';
import { type BriefRecoveryAction, EvidenceRefSchema } from './brief-recovery/primitives.js';

const MAX_ID = 256;
const MAX_HASH = 512;
const MAX_BRIEF_BYTES = 1_024 * 1_024;
const MAX_COMMENT_BYTES = 4_096;
const MAX_INPUTS = 4_096;

const id = z.string().trim().min(1).max(MAX_ID);
const hash = z.string().trim().min(1).max(MAX_HASH);
const revision = z.number().int().nonnegative();

export const BRIEF_REVIEW_COMMAND_VERSION = 1 as const;

/**
 * These are the command discriminants accepted by the cross-client review rail.
 * Recovery status/action values remain owned by brief-recovery.ts; comment and import are
 * transport intents and therefore are not added to that persisted action enum.
 */
export const BRIEF_REVIEW_COMMAND_ACTIONS = [
  'retry',
  'edit',
  'reject',
  'approve',
  'comment',
  'import',
  'resolve-unresolved',
  'status',
] as const;

export type BriefReviewCommandAction = (typeof BRIEF_REVIEW_COMMAND_ACTIONS)[number];
export const BriefReviewActionIdSchema = z.enum(BRIEF_REVIEW_COMMAND_ACTIONS);

export const BRIEF_REVIEW_PROMPT_KINDS = ['spec', 'plan', 'briefs', 'artifact'] as const;
export const BriefReviewPromptKindSchema = z.enum(BRIEF_REVIEW_PROMPT_KINDS);
export type BriefReviewPromptKind = z.infer<typeof BriefReviewPromptKindSchema>;

export const BriefReviewProjectionSchema = BriefRecoveryProjectionV1Schema;

const boundedBrief = z
  .string()
  .min(1)
  .refine((value) => Buffer.byteLength(value, 'utf8') <= MAX_BRIEF_BYTES, {
    message: 'Brief payload exceeds the maximum byte length',
  });

const boundedComment = z
  .string()
  .trim()
  .min(1)
  .refine((value) => Buffer.byteLength(value, 'utf8') <= MAX_COMMENT_BYTES, {
    message: 'comment exceeds the maximum byte length',
  });

const uniqueIds = (minimum = 0) =>
  z
    .array(id)
    .min(minimum)
    .max(MAX_INPUTS)
    .readonly()
    .superRefine((values, ctx) => {
      if (new Set(values).size !== values.length) {
        ctx.addIssue({ code: 'custom', message: 'input IDs must be unique' });
      }
    });

const commandEnvelopeShape = {
  version: z.literal(BRIEF_REVIEW_COMMAND_VERSION),
  sessionId: id,
  epochId: id,
  operationId: id,
  expectedBriefRevision: revision,
  expectedReportRevision: revision.nullable(),
  intentHash: hash,
  base: EvidenceRefSchema,
  baseBrief: EvidenceRefSchema.optional(),
  baseReport: EvidenceRefSchema.nullable().optional(),
} as const;

const commandWith = <T extends z.ZodRawShape>(shape: T) =>
  z.object({ ...commandEnvelopeShape, ...shape }).strict();

const resolutionSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('rebind'),
      acknowledgeRemoteDuplicationRisk: z.literal(true),
    })
    .strict(),
  z.object({ kind: z.literal('abandon') }).strict(),
]);

const retryCommandSchema = commandWith({
  action: z.literal('retry'),
  diagnosticFingerprint: hash,
  frozenInputIds: uniqueIds(),
}).strict();

const editCommandSchema = commandWith({
  action: z.literal('edit'),
  briefText: boundedBrief,
  newInputId: id,
}).strict();

const rejectCommandSchema = commandWith({
  action: z.literal('reject'),
  userIntentId: id,
}).strict();

const approveCommandSchema = commandWith({ action: z.literal('approve') }).strict();

const commentCommandSchema = commandWith({
  action: z.literal('comment'),
  comment: boundedComment,
}).strict();

const importCommandSchema = commandWith({ action: z.literal('import') }).strict();

const resolveUnresolvedCommandSchema = commandWith({
  action: z.literal('resolve-unresolved'),
  heldInputIds: uniqueIds(1),
  resolution: resolutionSchema,
}).strict();

const statusCommandSchema = z
  .object({
    version: z.literal(BRIEF_REVIEW_COMMAND_VERSION),
    sessionId: id,
    epochId: id,
    action: z.literal('status'),
  })
  .strict();

/** The one versioned command contract shared by CLI, IPC, RPC, and TUI adapters. */
const briefReviewCommandUnion = z.discriminatedUnion('action', [
  retryCommandSchema,
  editCommandSchema,
  rejectCommandSchema,
  approveCommandSchema,
  commentCommandSchema,
  importCommandSchema,
  resolveUnresolvedCommandSchema,
  statusCommandSchema,
]);

export const BriefReviewCommandSchema = briefReviewCommandUnion.superRefine((command, ctx) => {
  if (command.action === 'status') return;

  if (command.base.revision !== command.expectedBriefRevision) {
    ctx.addIssue({
      code: 'custom',
      path: ['expectedBriefRevision'],
      message: 'expectedBriefRevision must match the base Brief revision',
    });
  }
  if (
    command.baseBrief !== undefined &&
    command.baseBrief.revision !== command.expectedBriefRevision
  ) {
    ctx.addIssue({
      code: 'custom',
      path: ['baseBrief', 'revision'],
      message: 'baseBrief revision must match expectedBriefRevision',
    });
  }
  if (
    command.baseReport !== undefined &&
    (command.baseReport === null
      ? command.expectedReportRevision !== null
      : command.baseReport.revision !== command.expectedReportRevision)
  ) {
    ctx.addIssue({
      code: 'custom',
      path: ['baseReport'],
      message: 'baseReport revision must match expectedReportRevision',
    });
  }
});

export type BriefReviewCommand = z.infer<typeof BriefReviewCommandSchema>;

export const BriefReviewResultSchema = RecoveryResultV1Schema;
export type { RecoveryResult, RecoveryResultV1 };

export type BriefReviewCommandDisposition =
  | { kind: 'settles'; result: ApprovalReviewResult }
  | { kind: 'save-draft' }
  | { kind: 'status' };

/**
 * A command is current only against the projection that supplied its revisions. This check is
 * deliberately separate from structural parsing: the schema cannot know which persisted head a
 * client observed.
 */
export function isBriefReviewCommandCurrent(
  command: BriefReviewCommand,
  projection: BriefRecoveryProjectionV1,
): boolean {
  if (command.sessionId !== projection.sessionId || command.epochId !== projection.epochId) {
    return false;
  }
  if (command.action === 'status') return true;
  const briefRevision = projection.activeBrief?.revision ?? 0;
  const reportRevision = projection.matchingReport?.report.revision ?? null;
  const revisionsMatch =
    command.expectedBriefRevision === briefRevision &&
    command.expectedReportRevision === reportRevision;
  if (!revisionsMatch || projection.activeBrief === null) return false;
  if (
    command.base.hash !== projection.activeBrief.hash ||
    command.base.revision !== projection.activeBrief.revision ||
    command.base.path !== projection.activeBrief.path
  ) {
    return false;
  }
  if (command.baseBrief !== undefined) {
    if (
      command.baseBrief.hash !== projection.activeBrief.hash ||
      command.baseBrief.revision !== projection.activeBrief.revision ||
      command.baseBrief.path !== projection.activeBrief.path
    ) {
      return false;
    }
  }
  if (command.baseReport !== undefined) {
    if (command.baseReport === null) return projection.matchingReport === null;
    const report = projection.matchingReport?.report;
    if (
      report === undefined ||
      command.baseReport.hash !== report.hash ||
      command.baseReport.revision !== report.revision ||
      command.baseReport.path !== report.path
    ) {
      return false;
    }
  }
  return true;
}

export function allowedBriefReviewCommandsForPrompt(
  promptKind: BriefReviewPromptKind,
): readonly BriefReviewCommandAction[] {
  return promptKind === 'briefs' ? BRIEF_REVIEW_COMMAND_ACTIONS : [];
}

export function allowedSettlingBriefReviewCommandsForPrompt(
  promptKind: BriefReviewPromptKind,
): readonly BriefReviewCommandAction[] {
  return allowedBriefReviewCommandsForPrompt(promptKind).filter((action) => action !== 'status');
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
    case 'edit':
      return { kind: 'settles', result: { approved: false, action: 'edit' } };
    case 'comment':
      return {
        kind: 'settles',
        result: { approved: false, action: 'revise', comment: command.comment },
      };
    case 'retry':
    case 'import':
    case 'resolve-unresolved':
    case 'status':
      return { kind: 'status' };
    default:
      return assertNever(command);
  }
}

export type { BriefRecoveryAction, BriefRecoveryProjectionV1 };
