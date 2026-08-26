import { createStore, storeBase } from '../create-store.js';
import { resolveAttachment } from '../../core/attachments/resolve.js';
import type { AttachImageResult } from '../../core/runtime/commands/types.js';
import type { Attachment } from '../../core/schemas/attachment.js';

export interface AttachmentsState {
  pending: Attachment[];
}

const initial: AttachmentsState = { pending: [] };

const store = createStore<AttachmentsState>(initial);

function cloneAttachment(attachment: Attachment): Attachment {
  return { ...attachment };
}

function cloneAttachments(attachments: Attachment[]): Attachment[] {
  return attachments.map(cloneAttachment);
}

function add(attachment: Attachment): void {
  store.set((s) => ({ pending: [...s.pending, cloneAttachment(attachment)] }));
}

function remove(id: string): void {
  store.set((s) => ({ pending: s.pending.filter((a) => a.id !== id) }));
}

function drain(): Attachment[] {
  const out = store.get().pending;
  if (out.length === 0) return [];
  store.set({ pending: [] });
  return cloneAttachments(out);
}

function peek(): Attachment[] {
  return cloneAttachments(store.get().pending);
}

export const attachmentsStore = {
  ...storeBase(store),
  add,
  remove,
  drain,
  peek,
};

export function attachImage(input: {
  path: string;
  projectDir: string;
  supportsImages: boolean;
}): AttachImageResult {
  if (!input.supportsImages) return { ok: false, reason: 'no-vision' };
  const result = resolveAttachment({ input: input.path, projectDir: input.projectDir });
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

    const match = pending.find((a) => a.id === idOrIndex || a.path.endsWith(idOrIndex));
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
  return attachmentsStore.peek().map((a) => ({ id: a.id, path: a.path }));
}
