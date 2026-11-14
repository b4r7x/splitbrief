import { SOFT_SEP } from '../../../core/separators.js';
import {
  ELLIPSIS,
  truncateTerminalDisplayText,
  truncateTerminalDisplayTextStart,
} from '../../../utils/display-text/truncate.js';
import { getTerminalCellWidth } from '../../../utils/display-text/width.js';

export interface LabelBase {
  readonly base: string;
  readonly room: number;
}

/** What a cut must not leave standing before its ellipsis: `qwen2.5-coder:…`, `GPT-5.6 Luna …`. */
const HANGING_SEPARATOR_RE = /[\s:/(-]+$/;
/** An id's tag, `:120b-cloud` in `gpt-oss:120b-cloud`: cut in half it names no model. */
const SPLIT_TAG_RE = /:[^\s:]*$/;
/** A name's leading words for a cut, each with the separator after it; an id's `:tag` is a word of its own. */
const HEAD_WORD_RE = /[^\s:-]+[\s-]*|:[^\s:-]*[\s-]*/g;

/** A kept head never ends on a separator, inside a parenthesis it opened, or on half an id's tag. */
function tidyHead(kept: string): string {
  const open = kept.lastIndexOf(' (');
  const whole = open > 0 && !kept.slice(open).includes(')') ? kept.slice(0, open) : kept;
  return whole.replace(SPLIT_TAG_RE, '').replace(HANGING_SEPARATOR_RE, '');
}

/**
 * A cut keeps whole words: `Gemini 3.8 Fla…` names no model. It never leaves a separator hanging
 * before the ellipsis, nor a parenthesis it has opened, nor half an id's tag: `Ling 3.0 Flash VL
 * (free)` reads `Ling 3.0 Flash VL…`, `qwen2.5-coder:7b` reads `qwen2.5-coder…` and
 * `gpt-oss:120b-cloud` reads `gpt-oss…`. Only a first word wider than the room is cut inside itself.
 */
export function cutLabel(label: string, room: number): string {
  if (getTerminalCellWidth(label) <= room) return label;
  const words = label.match(HEAD_WORD_RE) ?? [];
  for (let kept = words.length - 1; kept >= 1; kept--) {
    const head = tidyHead(words.slice(0, kept).join(''));
    if (head !== '' && getTerminalCellWidth(`${head}${ELLIPSIS}`) <= room) {
      return `${head}${ELLIPSIS}`;
    }
  }
  return roomCut(label, room);
}

/** What `room` cells hold of a name, a tag or a separator given back: the floor is measured on it. */
export function roomCut(label: string, room: number): string {
  const cut = truncateTerminalDisplayText(label, room);
  if (!cut.endsWith(ELLIPSIS) || cut === ELLIPSIS) return cut;
  return `${tidyHead(cut.slice(0, -ELLIPSIS.length))}${ELLIPSIS}`;
}

/** A name's words, each with the separator after it: `claude-fable-5.1` → `claude-`, `fable-`, `5.1`. */
const WORD_RE = /[^\s-]+[\s-]*/g;

/**
 * A cut reads as its own row only while no other name starts with what it kept before the
 * ellipsis and ends with what it kept after it: `claude-fable-5…` beside `claude-fable-5` could be
 * either, `Ling 3.0 Flash…` three times is all three, and `…(free)` is every free route in the list.
 */
function isAmbiguousCut(label: string, id: string, bases: ReadonlyMap<string, LabelBase>): boolean {
  const at = label.indexOf(ELLIPSIS);
  if (at < 0) return false;
  const head = label.slice(0, at);
  const tail = label.slice(at + ELLIPSIS.length);
  for (const [other, { base }] of bases) {
    if (other === id) continue;
    if (base.startsWith(head) && base.endsWith(tail)) return true;
  }
  return false;
}

/**
 * The longest run of whole trailing words that fits, after the words it gave up. It never opens
 * on a separator: `…deepseek-flash`, not `…· deepseek-flash`.
 */
function wordTail(text: string, room: number): string | undefined {
  const words = text.match(WORD_RE) ?? [text];
  for (let dropped = 1; dropped < words.length; dropped++) {
    if (words[dropped]?.trim() === SOFT_SEP.trim()) continue;
    const tail = `${ELLIPSIS}${words.slice(dropped).join('')}`;
    if (getTerminalCellWidth(tail) <= room) return tail;
  }
  return undefined;
}

/**
 * Twins are named by the model and the id that tells them apart (`nameRows`). Cut, a twin keeps
 * the model whole and gives up the leading words of the id, which its twins share:
 * `DeepSeek V4.1 Flash · …v4.1-flash`.
 */
function twinLabel(base: string, room: number): string | undefined {
  const at = base.indexOf(SOFT_SEP);
  if (at < 0) return undefined;
  const name = base.slice(0, at + SOFT_SEP.length);
  const tail = wordTail(base.slice(name.length), room - getTerminalCellWidth(name));
  return tail === undefined ? undefined : `${name}${tail}`;
}

/**
 * The room a twin needs to keep its model and still read as its own row: its shortest twin label
 * no other name could be, else its whole name. A name that is no twin needs none.
 */
export function twinFloorOf(id: string, bases: ReadonlyMap<string, LabelBase>): number {
  const base = bases.get(id)?.base ?? '';
  if (!base.includes(SOFT_SEP)) return 0;
  const nameWidth = getTerminalCellWidth(base);
  for (let room = 1; room < nameWidth; room++) {
    const label = twinLabel(base, room);
    if (label !== undefined && !isAmbiguousCut(label, id, bases)) return room;
  }
  return nameWidth;
}

/**
 * A label cut to its room must still name its own row. A cut another name also starts with gives
 * up its leading words instead and keeps the ones that tell it apart — a twin the leading words of
 * its id (`DeepSeek V4.1 Flash · …v4.1-flash`), any other name its own (`…Fin (free)`,
 * `…Sante (free)`, `…VL (free)`, `…fable-5.1`). Telling rows apart outranks whole words: where no
 * whole-word form does, the head is cut inside a word (`Nemotron 3.5 L…` beside
 * `…Safety (free)`), and where two tails still read alike, each keeps as much of its end as the
 * room holds.
 */
export function separateCollisions(
  labels: Map<string, string>,
  bases: ReadonlyMap<string, LabelBase>,
): void {
  for (const [id, label] of labels) {
    const entry = bases.get(id);
    if (entry === undefined || !isAmbiguousCut(label, id, bases)) continue;
    const tail =
      wordTail(entry.base, entry.room) ?? truncateTerminalDisplayTextStart(entry.base, entry.room);
    const head = roomCut(entry.base, entry.room);
    const candidates = [twinLabel(entry.base, entry.room), tail, head];
    labels.set(
      id,
      candidates.find(
        (candidate) => candidate !== undefined && !isAmbiguousCut(candidate, id, bases),
      ) ?? tail,
    );
  }
  const idsByLabel = new Map<string, string[]>();
  for (const [id, label] of labels) idsByLabel.set(label, [...(idsByLabel.get(label) ?? []), id]);
  for (const ids of idsByLabel.values()) {
    if (ids.length < 2) continue;
    for (const id of ids) {
      const entry = bases.get(id);
      if (entry !== undefined)
        labels.set(id, truncateTerminalDisplayTextStart(entry.base, entry.room));
    }
  }
}
