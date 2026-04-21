import { z } from 'zod';

export const SUPPORTED_IMAGE_EXTS = ['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp'] as const;
export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;

export const AttachmentKindSchema = z.enum(['image']);

export const AttachmentSchema = z.object({
  id: z.string(),
  kind: AttachmentKindSchema,
  path: z.string(),
  mimeType: z.string(),
  sizeBytes: z.number().int().positive(),
  addedAt: z.number().int(),
});

export type Attachment = z.infer<typeof AttachmentSchema>;

export const EXT_TO_MIME: Record<string, string> = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  gif: 'image/gif',
  webp: 'image/webp',
  bmp: 'image/bmp',
};
