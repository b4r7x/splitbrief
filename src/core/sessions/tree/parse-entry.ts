import type { z } from 'zod';
import type { TreeEntryEnvelope } from './schemas.js';

export interface TypedEntry<T = unknown> {
  envelope: TreeEntryEnvelope;
  payload: T;
  valid: true;
}

export function parseEntryAs<T>(
  envelope: TreeEntryEnvelope,
  expectedType: string,
  schema: z.ZodType<T>,
): TypedEntry<T> | null {
  if (envelope.type !== expectedType) return null;
  const result = schema.safeParse(envelope.payload);
  if (!result.success) return null;
  return { envelope, payload: result.data, valid: true };
}
