import { createStore, storeBase } from '../create-store.js';
import type { Attachment } from '../../core/schemas/attachment.js';

export interface AttachmentsState {
  pending: Attachment[];
}

const initial: AttachmentsState = { pending: [] };

const store = createStore<AttachmentsState>(initial);

function add(attachment: Attachment): void {
  store.set(s => ({ pending: [...s.pending, attachment] }));
}

function remove(id: string): void {
  store.set(s => ({ pending: s.pending.filter(a => a.id !== id) }));
}

function drain(): Attachment[] {
  const out = store.get().pending;
  if (out.length === 0) return out;
  store.set({ pending: [] });
  return out;
}

function peek(): Attachment[] {
  return store.get().pending;
}

export const attachmentsStore = {
  ...storeBase(store),
  add,
  remove,
  drain,
  peek,
};
