import type { AttachmentFailureReason } from '../attachments/failure.js';
import { formatAttachedText, resolveAttachment, resolveInputFile } from '../attachments/resolve.js';
import type { AttachedInput, Attachment } from '../schemas/attachment.js';
import type { DraftDocument, DraftPart } from '../schemas/draft-document.js';
import type { UserMessageInput } from '../types/user-input.js';
import { isRuntimeCommandLine } from '../runtime/commands/lookup.js';
import { normalizeDraftDocument } from './document.js';

export type DraftSubmission =
  | { ok: true; document: DraftDocument; message: UserMessageInput; plannerContext: string }
  | { ok: false; reason: 'command' }
  | { ok: false; reason: AttachmentFailureReason | 'no-vision'; imageId?: string; path?: string };

/** A draft that opens with a slash command is a command: it runs, and no seat ever reads it. */
export function isCommandDraft(document: DraftDocument): boolean {
  const first = normalizeDraftDocument(document).parts[0];
  return first?.kind === 'text' && isRuntimeCommandLine(first.text.trimStart());
}

export function prepareDraftSubmission(
  document: DraftDocument,
  opts: { projectDir: string; supportsImages: boolean },
): DraftSubmission {
  if (isCommandDraft(document)) return { ok: false, reason: 'command' };
  const parts: DraftPart[] = [];
  const images: Attachment[] = [];
  const attachedInputs: AttachedInput[] = [];
  const attachedTextBlocks: string[] = [];
  const normalized = normalizeDraftDocument(document);
  for (const [index, part] of normalized.parts.entries()) {
    if (part.kind === 'text') {
      let cursor = 0;
      for (const match of part.text.matchAll(/@("([^"]*)"|'([^']*)'|(?:\\[\s\S]|[^\s])+)/g)) {
        const startsDocument = index === 0 && match.index === 0;
        if (!startsDocument && !/\s/.test(part.text.charAt(match.index - 1))) continue;
        const typedPath = match[0].slice(1);
        const quoted = match[2] !== undefined || match[3] !== undefined;
        const explicit = typedPath.includes('/') || quoted;
        const path = quoted ? typedPath.slice(1, -1) : typedPath.replace(/\\([\s\S])/g, '$1');
        const result = resolveInputFile({ path, projectDir: opts.projectDir });
        if (!result.ok) {
          if (!explicit && result.reason === 'not-found') continue;
          return { ok: false, reason: result.reason, path: typedPath };
        }
        if (result.kind === 'text') {
          attachedTextBlocks.push(formatAttachedText(typedPath, result.content));
        } else {
          if (!opts.supportsImages) return { ok: false, reason: 'no-vision', path: typedPath };
          parts.push({ kind: 'text', text: part.text.slice(cursor, match.index) });
          parts.push({ kind: 'image', attachment: result.attachment });
          images.push(result.attachment);
          cursor = match.index + match[0].length;
        }
        attachedInputs.push({ kind: result.kind, path: result.path });
      }
      parts.push({ kind: 'text', text: part.text.slice(cursor) });
      continue;
    }
    const imageId = part.attachment.id;
    const path = part.attachment.path;
    if (!opts.supportsImages) return { ok: false, reason: 'no-vision', imageId, path };
    const result = resolveAttachment({ attachment: part.attachment, projectDir: opts.projectDir });
    if (!result.ok) return { ok: false, reason: result.reason, imageId, path };
    const attachment = result.attachment;
    parts.push({ kind: 'image', attachment });
    images.push(attachment);
    attachedInputs.push({ kind: 'image', path: attachment.path });
  }
  const submittedDocument = normalizeDraftDocument({ version: 1, parts });
  const displayText = compileSubmissionText(submittedDocument.parts, images);
  const plannerContext = attachedTextBlocks.join('\n\n');
  const text = plannerContext === '' ? displayText : `${displayText}\n\n${plannerContext}`;
  return {
    ok: true,
    document: submittedDocument,
    message: { text, displayText, images, attachedInputs },
    plannerContext,
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
