import { z } from 'zod';
import { TaskIdSchema } from './task.js';

const ReviewFileEntrySchema = z
  .object({
    base64: z.string(),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    mode: z.number().int().min(0).max(0o777),
  })
  .nullable();
export type ReviewFileEntry = z.infer<typeof ReviewFileEntrySchema>;

const ReviewChangeIdentity = {
  taskId: TaskIdSchema,
  briefHash: z.string(),
  path: z.string().min(1),
};

const ReviewChangeSchema = z.discriminatedUnion('kind', [
  z.object({
    ...ReviewChangeIdentity,
    kind: z.literal('captured'),
    before: ReviewFileEntrySchema,
    after: ReviewFileEntrySchema,
  }),
  z.object({
    ...ReviewChangeIdentity,
    kind: z.literal('unknown'),
    reason: z.enum(['input-unverified', 'output-changed', 'capture-failed']),
  }),
]);
export type ReviewChange = z.infer<typeof ReviewChangeSchema>;

export const ReviewChangesSchema = z.object({
  version: z.literal(1),
  sessionId: z.string(),
  changes: z.array(ReviewChangeSchema),
});
export type ReviewChanges = z.infer<typeof ReviewChangesSchema>;

export const ReviewProvenanceSchema = z.object({
  path: z.string(),
  status: z.enum(['available', 'missing', 'invalid']),
  promotedFiles: z.array(z.string()),
  workspaceFiles: z.array(z.string()),
  uncertainFiles: z.array(z.string()),
  preRunFiles: z.array(z.string()).default([]),
});
export type ReviewProvenance = z.infer<typeof ReviewProvenanceSchema>;
