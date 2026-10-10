import { error, matches } from '../../utils/error.js';
import type { Attachment } from '../schemas/attachment.js';
import {
  type DraftDocument,
  type DraftPart,
  findDuplicateImageId,
} from '../schemas/draft-document.js';

export interface DraftRange {
  start: number;
  end: number;
}

export interface DraftEdit {
  document: DraftDocument;
  caret: number;
}

export const draftError = {
  duplicateImageId: (id: string) =>
    error('draft-duplicate-image-id', `Image ${id} is already in the draft`, { id }),
  isDuplicateImageId: matches('draft-duplicate-image-id'),
} as const;

export function createDraftDocument(text: string): DraftDocument {
  return normalizeDraftDocument({ version: 1, parts: [{ kind: 'text', text }] });
}

export function normalizeDraftDocument(document: DraftDocument): DraftDocument {
  const duplicate = findDuplicateImageId(document.parts);
  if (duplicate !== undefined) throw draftError.duplicateImageId(duplicate);
  const parts: DraftPart[] = [];
  for (const part of document.parts) {
    const last = parts.at(-1);
    if (part.kind === 'image') parts.push(part);
    else if (part.text === '') continue;
    else if (last?.kind === 'text')
      parts[parts.length - 1] = { kind: 'text', text: last.text + part.text };
    else parts.push({ kind: 'text', text: part.text });
  }
  return { version: 1, parts };
}

export function draftLength(document: DraftDocument): number {
  let length = 0;
  for (const part of document.parts) {
    length += part.kind === 'image' ? 1 : Array.from(part.text).length;
  }
  return length;
}

export function replaceDraftRange(
  document: DraftDocument,
  range: DraftRange,
  insertedParts: readonly DraftPart[],
): DraftEdit {
  const length = draftLength(document);
  const from = clamp(range.start, length);
  const to = clamp(range.end, length);
  const start = Math.min(from, to);
  const end = Math.max(from, to);
  const inserted = normalizeDraftDocument({ version: 1, parts: [...insertedParts] });
  const next = normalizeDraftDocument({
    version: 1,
    parts: [
      ...sliceParts(document.parts, 0, start),
      ...inserted.parts,
      ...sliceParts(document.parts, end, length),
    ],
  });
  return { document: next, caret: start + draftLength(inserted) };
}

export function insertDraftImage(
  document: DraftDocument,
  offset: number,
  attachment: Attachment,
): DraftEdit {
  return replaceDraftRange(document, { start: offset, end: offset }, [
    { kind: 'image', attachment },
  ]);
}

function clamp(offset: number, length: number): number {
  return Math.min(Math.max(offset, 0), length);
}

function sliceParts(parts: readonly DraftPart[], start: number, end: number): DraftPart[] {
  const sliced: DraftPart[] = [];
  let offset = 0;
  for (const part of parts) {
    if (part.kind === 'image') {
      if (offset >= start && offset < end) sliced.push(part);
      offset += 1;
      continue;
    }
    const codePoints = Array.from(part.text);
    const from = Math.max(start - offset, 0);
    const to = Math.min(end - offset, codePoints.length);
    if (from < to) sliced.push({ kind: 'text', text: codePoints.slice(from, to).join('') });
    offset += codePoints.length;
  }
  return sliced;
}
