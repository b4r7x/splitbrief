import { z } from 'zod';
import { AttachmentSchema } from './attachment.js';

export const DraftTextPartSchema = z.object({
  kind: z.literal('text'),
  text: z.string(),
});

export const DraftImagePartSchema = z.object({
  kind: z.literal('image'),
  attachment: AttachmentSchema,
});

export const DraftPartSchema = z.discriminatedUnion('kind', [
  DraftTextPartSchema,
  DraftImagePartSchema,
]);

/** @public */
export type DraftTextPart = z.infer<typeof DraftTextPartSchema>;
/** @public */
export type DraftImagePart = z.infer<typeof DraftImagePartSchema>;
export type DraftPart = z.infer<typeof DraftPartSchema>;

export function findDuplicateImageId(parts: readonly DraftPart[]): string | undefined {
  const seen = new Set<string>();
  for (const part of parts) {
    if (part.kind !== 'image') continue;
    if (seen.has(part.attachment.id)) return part.attachment.id;
    seen.add(part.attachment.id);
  }
  return undefined;
}

export const DraftDocumentSchema = z
  .object({
    version: z.literal(1),
    parts: z.array(DraftPartSchema),
  })
  .superRefine((document, ctx) => {
    const duplicate = findDuplicateImageId(document.parts);
    if (duplicate === undefined) return;
    ctx.addIssue({
      code: 'custom',
      message: `image ${duplicate} appears more than once in the draft`,
      path: ['parts'],
    });
  });

export type DraftDocument = z.infer<typeof DraftDocumentSchema>;
