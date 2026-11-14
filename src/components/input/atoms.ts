/** An indivisible span of `value`: the caret never lands inside it and an edit takes all of it. */
export interface InputAtom {
  start: number;
  end: number;
}

/** The change an input event made to `value`, as a range replacement rather than a new string. */
export interface InputRange {
  start: number;
  end: number;
  text: string;
}

export interface InputEdit extends InputRange {
  /** Where the caret stood when the input event arrived. */
  caret: number;
}

// Every key this component handles rewrites one contiguous span, so the change can be recovered as
// a range instead of guessed from a whole-string diff. Where several ranges would produce the same
// string (deleting one of two adjacent atoms), the caret the edit left behind picks between them.
export function resolveInputEdit(previous: string, next: string, cursor: number): InputRange {
  const limit = Math.min(previous.length, next.length);
  let prefix = 0;
  while (prefix < limit && previous[prefix] === next[prefix]) prefix += 1;
  let suffix = 0;
  while (
    suffix < limit - prefix &&
    previous[previous.length - 1 - suffix] === next[next.length - 1 - suffix]
  ) {
    suffix += 1;
  }

  const inserted = next.length - suffix - prefix;
  const removed = previous.length - suffix - prefix;
  if (inserted === 0 && removed === 0) return { start: cursor, end: cursor, text: '' };

  const target = cursor - inserted;
  let start = prefix;
  while (start > target && start > 0 && rebuilds(previous, next, start - 1, inserted, removed)) {
    start -= 1;
  }
  return { start, end: start + removed, text: next.slice(start, start + inserted) };
}

function rebuilds(
  previous: string,
  next: string,
  start: number,
  inserted: number,
  removed: number,
): boolean {
  return (
    previous.slice(0, start) +
      next.slice(start, start + inserted) +
      previous.slice(start + removed) ===
    next
  );
}

export function expandEditOverAtoms(atoms: readonly InputAtom[], edit: InputRange): InputRange {
  let start = edit.start;
  let end = edit.end;
  for (const atom of atoms) {
    if (start === end) {
      if (start > atom.start && start < atom.end) {
        start = atom.end;
        end = atom.end;
      }
      continue;
    }
    if (atom.start < end && atom.end > start) {
      start = Math.min(start, atom.start);
      end = Math.max(end, atom.end);
    }
  }
  return { start, end, text: edit.text };
}

export function snapCaretOutOfAtoms(
  atoms: readonly InputAtom[],
  index: number,
  prefer: 'backward' | 'forward',
): number {
  for (const atom of atoms) {
    if (index > atom.start && index < atom.end) {
      return prefer === 'backward' ? atom.start : atom.end;
    }
  }
  return index;
}
