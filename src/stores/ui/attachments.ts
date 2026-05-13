import { resolveAttachment, type ResolveAttachmentReason } from '../../core/attachments/resolve.js';
import { attachmentsStore } from '../workflow/attachments.js';

export type AttachImageResult =
  | { ok: true; path: string }
  | { ok: false; reason: ResolveAttachmentReason };

export function attachImage(input: string, projectDir: string): AttachImageResult {
  const result = resolveAttachment({ input, projectDir });
  if (!result.ok) return { ok: false, reason: result.reason };
  attachmentsStore.add(result.attachment);
  return { ok: true, path: result.attachment.path };
}

export function detachImage(idOrIndex?: string): boolean {
  const pending = attachmentsStore.peek();
  if (pending.length === 0) return false;

  if (idOrIndex) {
    if (/^\d+$/.test(idOrIndex)) {
      const asIndex = Number.parseInt(idOrIndex, 10);
      if (asIndex < 1 || asIndex > pending.length) return false;
      const target = pending.at(asIndex - 1);
      if (!target) return false;
      attachmentsStore.remove(target.id);
      return true;
    }

    const match = pending.find(a => a.id === idOrIndex || a.path.endsWith(idOrIndex));
    if (!match) return false;
    attachmentsStore.remove(match.id);
    return true;
  }

  const last = pending.at(-1);
  if (!last) return false;
  attachmentsStore.remove(last.id);
  return true;
}

export function listAttachments(): Array<{ id: string; path: string }> {
  return attachmentsStore.peek().map(a => ({ id: a.id, path: a.path }));
}
