import { z } from 'zod';

export const EntryIdSchema = z.string().brand<'EntryId'>();
export type EntryId = z.infer<typeof EntryIdSchema>;
export function entryId(s: string): EntryId {
  return EntryIdSchema.parse(s);
}

export const TreeEntryEnvelopeSchema = z.object({
  id: EntryIdSchema,
  parentId: EntryIdSchema.nullable(),
  type: z.string(),
  timestamp: z.number(),
  payload: z.unknown(),
  display: z.boolean().optional(),
});
export type TreeEntryEnvelope = z.infer<typeof TreeEntryEnvelopeSchema>;

export const TreeMetaSchema = z.object({
  leafId: EntryIdSchema,
  entryCount: z.number().int().nonnegative(),
  branchCount: z.number().int().nonnegative(),
  createdAt: z.number(),
  updatedAt: z.number(),
});
export type TreeMeta = z.infer<typeof TreeMetaSchema>;

export function nextEntryId(currentCount: number): EntryId {
  const num = currentCount + 1;
  const padded = String(num).padStart(4, '0');
  return entryId(`E${padded}`);
}
