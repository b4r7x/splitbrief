import { createStore, storeBase } from '../create-store.js';
import { createDraftDocument, normalizeDraftDocument } from '../../core/composer/document.js';
import type { Screen } from '../../core/navigation/types.js';
import type { DraftDocument, DraftPart } from '../../core/schemas/draft-document.js';
import { sanitizePasteBody } from '../../lib/terminal/filtered-stdin/paste.js';

export interface InputHistoryState {
  entries: DraftDocument[];
  workflowEntries: DraftDocument[];
}

export const MAX_INPUT_HISTORY = 50;

const initial: InputHistoryState = { entries: [], workflowEntries: [] };

const store = createStore<InputHistoryState>(initial);

export interface InputHistorySubmissionOptions {
  currentScreen: Screen;
}

export interface InputHistoryEntriesOptions {
  currentScreen: Screen;
}

export function draftDocumentText(document: DraftDocument): string {
  return document.parts.map((part) => (part.kind === 'text' ? part.text : '')).join('');
}

function isBlankDocument(document: DraftDocument): boolean {
  return document.parts.every((part) => part.kind === 'text' && part.text.trim() === '');
}

function isSamePart(a: DraftPart, b: DraftPart): boolean {
  if (a.kind === 'text' || b.kind === 'text') {
    return a.kind === 'text' && b.kind === 'text' && a.text === b.text;
  }
  return (
    a.attachment.id === b.attachment.id &&
    a.attachment.path === b.attachment.path &&
    a.attachment.mimeType === b.attachment.mimeType &&
    a.attachment.sizeBytes === b.attachment.sizeBytes
  );
}

function isSameDocument(a: DraftDocument, b: DraftDocument): boolean {
  if (a.parts.length !== b.parts.length) return false;
  return a.parts.every((part, index) => {
    const other = b.parts[index];
    return other !== undefined && isSamePart(part, other);
  });
}

function sanitizeDocumentText(document: DraftDocument): DraftDocument {
  return {
    version: 1,
    parts: document.parts.map((part) =>
      part.kind === 'text' ? { ...part, text: sanitizePasteBody(part.text) } : part,
    ),
  };
}

export function normalizeInputHistoryEntries(entries: readonly DraftDocument[]): DraftDocument[] {
  const deduped: DraftDocument[] = [];
  for (const entry of entries) {
    const document = normalizeDraftDocument(sanitizeDocumentText(entry));
    if (isBlankDocument(document)) continue;
    if (deduped.some((kept) => isSameDocument(kept, document))) continue;
    deduped.push(document);
    if (deduped.length >= MAX_INPUT_HISTORY) break;
  }
  return deduped;
}

function putEntry(
  entries: readonly DraftDocument[],
  document: DraftDocument,
): DraftDocument[] | null {
  const first = entries[0];
  if (first !== undefined && isSameDocument(first, document)) return null;
  return [document, ...entries.filter((entry) => !isSameDocument(entry, document))].slice(
    0,
    MAX_INPUT_HISTORY,
  );
}

function push(value: string): void {
  const trimmed = value.trim();
  if (!trimmed) return;
  const document = createDraftDocument(trimmed);
  store.set((state) => {
    const entries = putEntry(state.entries, document);
    return entries === null ? state : { ...state, entries };
  });
}

function pushDocumentSubmission(
  document: DraftDocument,
  opts: InputHistorySubmissionOptions,
): void {
  const normalized = normalizeDraftDocument(document);
  if (isBlankDocument(normalized)) return;

  store.set((state) => {
    const entries = putEntry(state.entries, normalized) ?? state.entries;
    const workflowEntries =
      opts.currentScreen === 'home'
        ? state.workflowEntries
        : (putEntry(state.workflowEntries, normalized) ?? state.workflowEntries);

    if (entries === state.entries && workflowEntries === state.workflowEntries) return state;
    return { entries, workflowEntries };
  });
}

function pushSubmission(value: string, opts: InputHistorySubmissionOptions): void {
  pushDocumentSubmission(createDraftDocument(value.trim()), opts);
}

function hydrate(entries: readonly (string | DraftDocument)[]): void {
  store.set({
    entries: normalizeInputHistoryEntries(
      entries.map((entry) =>
        typeof entry === 'string' ? createDraftDocument(entry.trim()) : entry,
      ),
    ),
    workflowEntries: [],
  });
}

export function getInputHistoryDocuments(
  state: InputHistoryState,
  opts: InputHistoryEntriesOptions,
): DraftDocument[] {
  if (opts.currentScreen === 'home') return state.entries;
  return normalizeInputHistoryEntries([...state.workflowEntries, ...state.entries]);
}

export function getInputHistoryEntries(
  state: InputHistoryState,
  opts: InputHistoryEntriesOptions,
): string[] {
  return getInputHistoryDocuments(state, opts).map(draftDocumentText);
}

export const inputHistoryStore = {
  ...storeBase(store),
  push,
  pushSubmission,
  pushDocumentSubmission,
  hydrate,
};
