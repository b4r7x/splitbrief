import { z } from 'zod';

export const RpcCommandSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('approve') }),
  z.object({ type: z.literal('reject'), comment: z.string().optional() }),
  z.object({ type: z.literal('message'), text: z.string().min(1) }),
  z.object({ type: z.literal('recovery'), action: z.string().min(1) }),
  z.object({ type: z.literal('status') }),
  z.object({ type: z.literal('abort') }),
  z.object({ type: z.literal('slash'), command: z.string().min(1) }),
]);

export type RpcCommand = z.infer<typeof RpcCommandSchema>;

export type RpcResponse = {
  type: 'ack' | 'error' | 'status' | 'event';
  command?: string;
  data?: unknown;
  error?: string;
};
