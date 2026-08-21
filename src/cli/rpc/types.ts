import { z } from 'zod';
import { BriefReviewCommandSchema } from '../../core/schemas/brief-review-command.js';

export const RPC_MAX_FRAME_BYTES = 1024 * 1024;
export const RPC_MAX_TEXT_BYTES = 256 * 1024;
export const RPC_MAX_PENDING_OUTPUT_BYTES = 4 * RPC_MAX_FRAME_BYTES;

const RpcTextSchema = z.string().min(1).max(RPC_MAX_TEXT_BYTES);
const RpcIdSchema = z.string().min(1).max(512);

/**
 * The RPC envelope carries only transport correlation fields.  The recovery
 * identity and bounded payload belong to the shared core command contract.
 * Keeping the envelope strict prevents a second, silently divergent command
 * shape from being accepted by the CLI boundary.
 */
export const RpcBriefReviewCommandSchema = z
  .object({
    type: z.literal('brief_review'),
    id: RpcIdSchema.optional(),
    operationId: RpcIdSchema.optional(),
    promptId: RpcIdSchema.optional(),
    command: BriefReviewCommandSchema,
  })
  .strict()
  .superRefine((envelope, ctx) => {
    if (
      envelope.operationId !== undefined &&
      envelope.command.action !== 'status' &&
      envelope.operationId !== envelope.command.operationId
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['operationId'],
        message: 'RPC operationId must match the Brief Review command operationId',
      });
    }
  });

export const RpcCommandSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('approve'),
    confirmationPhrase: z.string().optional(),
    confirmationReason: z.string().optional(),
  }),
  z.object({ type: z.literal('reject') }),
  z.object({ type: z.literal('regenerate'), comment: RpcTextSchema }),
  z.object({ type: z.literal('message'), text: RpcTextSchema }),
  z.object({ type: z.literal('recovery'), action: RpcTextSchema }),
  z.object({ type: z.literal('status') }),
  z.object({ type: z.literal('abort') }),
  z.object({ type: z.literal('slash'), command: RpcTextSchema }),
  RpcBriefReviewCommandSchema,
]);

export type RpcCommand = z.infer<typeof RpcCommandSchema>;

export type RpcResponse = {
  type: 'ack' | 'error' | 'status' | 'event';
  command?: string;
  data?: unknown;
  error?: string;
};
