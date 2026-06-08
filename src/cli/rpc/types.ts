import { z } from 'zod';

export const RPC_MAX_FRAME_BYTES = 1024 * 1024;
export const RPC_MAX_TEXT_BYTES = 256 * 1024;

const RpcTextSchema = z.string().min(1).max(RPC_MAX_TEXT_BYTES);

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
]);

export type RpcCommand = z.infer<typeof RpcCommandSchema>;

export type RpcResponse = {
  type: 'ack' | 'error' | 'status' | 'event';
  command?: string;
  data?: unknown;
  error?: string;
};
