import { isDeepStrictEqual } from 'node:util';
import { useRef, useState } from 'react';
import {
  createDraftDocument,
  draftLength,
  insertDraftImage,
  normalizeDraftDocument,
  replaceDraftRange,
} from '../../core/composer/document.js';
import type { Attachment } from '../../core/schemas/attachment.js';
import type { DraftDocument } from '../../core/schemas/draft-document.js';
import {
  expandEditOverAtoms,
  resolveInputEdit,
  type InputAtom,
  type InputRange,
} from '../input/multiline-input.js';

const PASTE_LINE_THRESHOLD = 4;

/** A collapsed paste: a span of the document the box shows as one marker. The text stays put. */
interface DraftFold {
  id: string;
  start: number;
  end: number;
  lineCount: number;
}

interface DraftRun {
  viewStart: number;
  viewEnd: number;
  draftStart: number;
  draftEnd: number;
  text: string;
  atom: boolean;
}

interface DraftView {
  text: string;
  atoms: InputAtom[];
  runs: DraftRun[];
}

// Both atom kinds are spelled the same way — bracketed, lower case, `#n` — so that inside the prose
// they read as one family of things the draft carries rather than as words the operator typed. The
// number is the one the submission legend binds to the attachment.
function imageAtomLabel(index: number): string {
  return `[image #${index + 1}]`;
}

function pasteAtomLabel(index: number, lineCount: number): string {
  return `[paste #${index + 1} +${lineCount} lines]`;
}

function pasteLineCount(text: string): number {
  return text.length === 0 ? 0 : text.split('\n').length;
}

function buildDraftView(document: DraftDocument, folds: readonly DraftFold[] = []): DraftView {
  const view: DraftView = { text: '', atoms: [], runs: [] };
  let draftOffset = 0;
  let imageIndex = 0;
  let foldIndex = 0;

  const push = (text: string, draftStart: number, draftEnd: number, atom: boolean) => {
    const viewStart = view.text.length;
    view.text += text;
    view.runs.push({ viewStart, viewEnd: view.text.length, draftStart, draftEnd, text, atom });
    if (atom) view.atoms.push({ start: viewStart, end: view.text.length });
  };

  for (const part of document.parts) {
    if (part.kind === 'image') {
      push(imageAtomLabel(imageIndex), draftOffset, draftOffset + 1, true);
      imageIndex += 1;
      draftOffset += 1;
      continue;
    }
    const codePoints = Array.from(part.text);
    const partEnd = draftOffset + codePoints.length;
    let cursor = draftOffset;
    while (cursor < partEnd) {
      const fold = folds.find((entry) => entry.start === cursor && entry.end <= partEnd);
      if (fold !== undefined) {
        push(pasteAtomLabel(foldIndex, fold.lineCount), fold.start, fold.end, true);
        foldIndex += 1;
        cursor = fold.end;
        continue;
      }
      const next = folds.find((entry) => entry.start > cursor && entry.start < partEnd);
      const until = next?.start ?? partEnd;
      push(
        codePoints.slice(cursor - draftOffset, until - draftOffset).join(''),
        cursor,
        until,
        false,
      );
      cursor = until;
    }
    draftOffset = partEnd;
  }
  return view;
}

/** Where a box offset lands in the document. Atoms are whole, so a boundary is never interpolated. */
function draftOffsetAt(view: DraftView, index: number): number {
  for (const run of view.runs) {
    if (index >= run.viewEnd) continue;
    if (index <= run.viewStart) return run.draftStart;
    if (run.atom) {
      return index - run.viewStart < run.viewEnd - index ? run.draftStart : run.draftEnd;
    }
    return run.draftStart + Array.from(run.text.slice(0, index - run.viewStart)).length;
  }
  return view.runs.at(-1)?.draftEnd ?? 0;
}

function viewOffsetOf(view: DraftView, draftOffset: number): number {
  for (const run of view.runs) {
    if (draftOffset >= run.draftEnd) continue;
    if (draftOffset <= run.draftStart) return run.viewStart;
    if (run.atom) return run.viewEnd;
    return (
      run.viewStart +
      Array.from(run.text)
        .slice(0, draftOffset - run.draftStart)
        .join('').length
    );
  }
  return view.text.length;
}

/** Trailing and leading whitespace is typing residue, not content; images keep their place. */
export function trimDraftDocument(document: DraftDocument): DraftDocument {
  const parts = [...document.parts];
  const first = parts[0];
  if (first?.kind === 'text') parts[0] = { kind: 'text', text: first.text.replace(/^\s+/, '') };
  const last = parts.at(-1);
  if (last?.kind === 'text') {
    parts[parts.length - 1] = { kind: 'text', text: last.text.replace(/\s+$/, '') };
  }
  return normalizeDraftDocument({ version: 1, parts });
}

function shiftFolds(
  folds: readonly DraftFold[],
  range: { start: number; end: number },
  delta: number,
): DraftFold[] {
  const kept: DraftFold[] = [];
  for (const fold of folds) {
    if (range.end <= fold.start) {
      kept.push({ ...fold, start: fold.start + delta, end: fold.end + delta });
      continue;
    }
    // An edit that reaches into a fold takes all of it: the box never shows half a marker.
    if (range.start >= fold.end) kept.push(fold);
  }
  return kept;
}

interface DraftState {
  document: DraftDocument;
  folds: DraftFold[];
}

/** The draft a command stands in front of, and the command as it was filled in. */
interface DraftHold {
  draft: DraftState;
  front: DraftDocument;
}

/** `front` on its own line above `back`, folds kept; either one alone when the other is empty. */
function joinDrafts(front: DraftState, back: DraftState): DraftState {
  if (draftLength(front.document) === 0) return back;
  if (draftLength(back.document) === 0) return front;
  const joint = [...front.document.parts, { kind: 'text' as const, text: '\n' }];
  const next = replaceDraftRange(back.document, { start: 0, end: 0 }, joint);
  const folds = shiftFolds(back.folds, { start: 0, end: 0 }, next.caret);
  return { document: next.document, folds: [...front.folds, ...folds] };
}

interface PasteDrafts {
  document: DraftDocument;
  view: DraftView;
  /** True when the edit emptied the box and the held draft came back in its place. */
  applyEdit: (edit: InputRange) => boolean;
  setText: (value: string) => boolean;
  /** A whole new draft — recall, restore, clear. Its markers belong to the draft they came from. */
  replaceDocument: (document: DraftDocument) => void;
  /**
   * A command in front of the draft: the draft is held, whole, and comes back the moment the box
   * is empty again, however it got there. An earlier command the box edited joins the held draft
   * on its own line.
   */
  holdDocument: (front: DraftDocument) => void;
  /** Text put back in front of the draft, joined on a new line, so neither one is lost. */
  prependDocument: (front: DraftDocument) => void;
  insertImage: (attachment: Attachment, at: number) => number;
}

export function usePasteDrafts(options?: {
  initialDocument: () => DraftDocument;
  /**
   * The draft to keep: while a command stands in front of a held draft, that draft with the edited
   * command joined below it.
   */
  onDocumentChange: (document: DraftDocument) => void;
}): PasteDrafts {
  const [state, setState] = useState<DraftState>(() => ({
    document: options?.initialDocument() ?? createDraftDocument(''),
    folds: [],
  }));
  const currentState = useRef(state);
  const holdRef = useRef<DraftHold | null>(null);
  // What the box would leave if its command went: the held draft, with the edited command below
  // it. A box that still reads as the command did joins nothing.
  const keptDraft = (box: DraftState): DraftState => {
    const hold = holdRef.current;
    if (hold === null) return box;
    return isDeepStrictEqual(box.document, hold.front) ? hold.draft : joinDrafts(hold.draft, box);
  };
  const updateState = (proposed: DraftState): boolean => {
    const hold = holdRef.current;
    const released = hold !== null && draftLength(proposed.document) === 0;
    if (released) holdRef.current = null;
    const next = released ? hold.draft : proposed;
    currentState.current = next;
    options?.onDocumentChange(keptDraft(next).document);
    setState(next);
    return released && draftLength(next.document) > 0;
  };
  const foldIdRef = useRef(0);
  const view = buildDraftView(state.document, state.folds);

  const applyEdit = (edit: InputRange) => {
    const inserted = Array.from(edit.text).length;
    const lineCount = pasteLineCount(edit.text);
    const foldId = lineCount >= PASTE_LINE_THRESHOLD ? `paste-${foldIdRef.current++}` : undefined;
    const current = currentState.current;
    const currentView = buildDraftView(current.document, current.folds);
    const start = draftOffsetAt(currentView, edit.start);
    const end = draftOffsetAt(currentView, edit.end);
    const next = replaceDraftRange(
      current.document,
      { start, end },
      edit.text === '' ? [] : [{ kind: 'text', text: edit.text }],
    );
    const folds = shiftFolds(current.folds, { start, end }, inserted - (end - start));
    if (foldId !== undefined) {
      folds.push({ id: foldId, start, end: start + inserted, lineCount });
      folds.sort((a, b) => a.start - b.start);
    }
    return updateState({ document: next.document, folds });
  };

  return {
    document: state.document,
    view,
    applyEdit,
    setText: (value) =>
      applyEdit(expandEditOverAtoms(view.atoms, resolveInputEdit(view.text, value, value.length))),
    replaceDocument: (document) => {
      updateState({ document, folds: [] });
    },
    holdDocument: (front) => {
      holdRef.current = { draft: keptDraft(currentState.current), front };
      updateState({ document: front, folds: [] });
    },
    prependDocument: (front) => {
      updateState(joinDrafts({ document: front, folds: [] }, currentState.current));
    },
    insertImage: (attachment, at) => {
      const current = currentState.current;
      const offset = draftOffsetAt(buildDraftView(current.document, current.folds), at);
      const next = insertDraftImage(current.document, offset, attachment);
      const folds = shiftFolds(current.folds, { start: offset, end: offset }, 1);
      updateState({ document: next.document, folds });
      return viewOffsetOf(buildDraftView(next.document, folds), next.caret);
    },
  };
}
