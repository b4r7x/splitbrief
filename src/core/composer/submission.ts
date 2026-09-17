import { type ResolveAttachmentReason, resolveAttachment } from '../attachments/resolve.js';
import type { Attachment } from '../schemas/attachment.js';
import type { DraftDocument, DraftPart } from '../schemas/draft-document.js';

export type DraftSubmission =
  | { ok: true; document: DraftDocument; text: string; images: Attachment[] }
  | { ok: false; reason: ResolveAttachmentReason | 'no-vision'; imageId?: string };

export function prepareDraftSubmission(
  document: DraftDocument,
  opts: { projectDir: string; supportsImages: boolean },
): DraftSubmission {
  const parts: DraftPart[] = [];
  const images: Attachment[] = [];
  for (const part of document.parts) {
    if (part.kind === 'text') {
      parts.push(part);
      continue;
    }
    const imageId = part.attachment.id;
    if (!opts.supportsImages) return { ok: false, reason: 'no-vision', imageId };
    const result = resolveAttachment({ input: part.attachment.path, projectDir: opts.projectDir });
    if (!result.ok) return { ok: false, reason: result.reason, imageId };
    const attachment = { ...result.attachment, id: imageId };
    parts.push({ kind: 'image', attachment });
    images.push(attachment);
  }
  return {
    ok: true,
    document: { version: 1, parts },
    text: compileSubmissionText(parts, images),
    images,
  };
}

function imageRef(attachment: Attachment): string {
  return `[image:${attachment.id}]`;
}

function compileSubmissionText(parts: readonly DraftPart[], images: readonly Attachment[]): string {
  const body = parts
    .map((part) => (part.kind === 'text' ? part.text : imageRef(part.attachment)))
    .join('');
  if (images.length === 0) return body;
  const legend = images.map((image, index) => `${imageRef(image)} = attached image ${index + 1}`);
  return `${body}\n\nImages referenced above, in attachment order:\n${legend.join('\n')}`;
}
