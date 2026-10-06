import { LIST_ROW_LABEL_FLOOR } from '../../components/list-row.js';
import { formatContextLength } from '../../core/formatting.js';
import { formatModelName } from '../../core/model-display.js';
import { isAutomaticModel } from '../../core/providers/automatic-model.js';
import { SOFT_SEP } from '../../core/separators.js';
import {
  ELLIPSIS,
  getTerminalCellWidth,
  truncateTerminalDisplayText,
  truncateTerminalDisplayTextStart,
} from '../../utils/display-text.js';
import { isOptionFamily, routePrefixesOf } from './model-catalog/option-axis.js';
import { modelIdUnderProvider } from './model-catalog/provider-axis.js';
import { AUTO_ROW_METADATA, sectionOf, type RightRow } from './model-catalog/rows.js';

type ModelRow = Extract<RightRow, { kind: 'model' }>;

/** What a model row spends beside its two columns: lead, metadata gap, disclosure, check. */
const MODEL_ROW_CHROME = 7;
/** The same row with no metadata at all: the gap goes with it. */
const BARE_MODEL_ROW_CHROME = MODEL_ROW_CHROME - 1;
/**
 * The room every name has at the picker's narrowest draw — a 21-cell row at 60 columns, less its
 * chrome. A cell that would squeeze a name below it yields the room instead.
 */
const MODEL_LABEL_FLOOR = 15;
/** `inclusionAI: Ling 3.0 Flash Fin (free)` — the vendor a gateway prepends to the model's name. */
const VENDOR_PREFIX_RE = /^[^:()]{1,24}: (?=\S)/;

interface LabelBase {
  readonly base: string;
  readonly room: number;
}

interface RowCells {
  readonly name: string;
  readonly chip: string;
  readonly tags: string;
  readonly prose: string;
  readonly size: string;
  readonly catalogId: string | undefined;
}

interface Rung {
  readonly catalogId: boolean;
  readonly chip: boolean;
  readonly prose: boolean;
  readonly size: boolean;
}

const TAGS_ONLY: Rung = { catalogId: false, chip: false, prose: false, size: false };

/**
 * Every set of cells a list can keep, richest first: the size outranks the prose detail, the prose
 * the count, and the count the catalog id — a cut id names a model that does not exist and a bare
 * digit is not a value, so neither is ever cut; the list keeps them whole or not at all. Read as
 * four bits, the sets count down from all four cells to none. Provenance and vendor tags are
 * states, not prose, and stay in every set.
 */
const RUNGS: readonly Rung[] = Array.from({ length: 16 }, (_, index) => {
  const kept = 15 - index;
  return {
    size: (kept & 8) !== 0,
    prose: (kept & 4) !== 0,
    chip: (kept & 2) !== 0,
    catalogId: (kept & 1) !== 0,
  };
});

/** One model row as drawn: its label, already fitted to the room its cells leave, and those cells. */
export interface PlannedModelRow {
  readonly label: string;
  readonly metadata: string | undefined;
  /** A namespaced id with no name sheds whole leading segments instead, and ListRow does that. */
  readonly path: boolean;
}

export interface ModelRowPlan {
  readonly width: number;
  readonly rows: ReadonlyMap<string, PlannedModelRow>;
}

function chipOf(row: ModelRow): string {
  const variants = row.model.variants ?? [];
  if (isOptionFamily(row.model)) return `${variants.length} options`;
  const routes = routePrefixesOf(variants).length;
  return routes > 1 ? `${routes} providers` : '';
}

function cellsOf(row: ModelRow, name: string): RowCells {
  const { model } = row;
  const automatic = isAutomaticModel(model.id);
  const provenance =
    row.provenance === 'Stale' || (row.provenance === 'Custom' && sectionOf(row) === undefined)
      ? row.provenance
      : '';
  return {
    name,
    chip: chipOf(row),
    tags: [provenance, model.vendorTag ?? ''].filter(Boolean).join(' '),
    prose: automatic ? '' : (model.detail ?? ''),
    // The Auto row carries no size; its word stands in that cell.
    size: automatic ? AUTO_ROW_METADATA : formatContextLength(model.contextLength),
    catalogId: model.catalogModelId,
  };
}

/**
 * Two models the list would name alike are told apart by the id their provider gives them —
 * `Kimi K3 · kimi-k3` and `Kimi K3 · k3` — or by the whole id where even that is shared. A custom
 * row leaves the name to the row the tool lists and reads the id it was given: `claude-opus-5-5`
 * pins the model the `opus` alias points at today, so the two stay two selections.
 */
function nameRows(
  rows: readonly ModelRow[],
  providerId: string | undefined,
): { row: ModelRow; name: string }[] {
  const named = rows.map((row) => ({
    row,
    name: row.model.displayName ?? formatModelName(row.model.id, providerId),
  }));
  const twinsByName = new Map<string, ModelRow[]>();
  for (const { row, name } of named) twinsByName.set(name, [...(twinsByName.get(name) ?? []), row]);
  return named.map(({ row, name }) => {
    const sameName = twinsByName.get(name) ?? [];
    const custom = row.provenance === 'Custom';
    const listed = sameName.filter((twin) => twin.provenance !== 'Custom');
    if (custom && listed.length > 0) return { row, name: row.model.id };
    const twins = custom ? sameName : listed;
    if (twins.length < 2) return { row, name };
    const own = modelIdUnderProvider(row.model.id);
    const shared = twins.some(
      (twin) => twin !== row && modelIdUnderProvider(twin.model.id) === own,
    );
    return { row, name: `${name}${SOFT_SEP}${shared ? row.model.id : own}` };
  });
}

function metadataAt(cells: RowCells, rung: Rung): string {
  const detail = rung.prose && cells.prose !== '' ? cells.prose : rung.size ? cells.size : '';
  const body = [cells.tags, detail].filter(Boolean).join(' ');
  const id = rung.catalogId ? cells.catalogId : undefined;
  const withId = id === undefined ? body : body === '' ? id : `${body}${SOFT_SEP}${id}`;
  return [rung.chip ? cells.chip : '', withId].filter(Boolean).join(' ');
}

function labelRoom(width: number, metadata: string): number {
  return metadata === ''
    ? width - BARE_MODEL_ROW_CHROME
    : width - MODEL_ROW_CHROME - getTerminalCellWidth(metadata);
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
function cutLabel(label: string, room: number): string {
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
function roomCut(label: string, room: number): string {
  const cut = truncateTerminalDisplayText(label, room);
  if (!cut.endsWith(ELLIPSIS) || cut === ELLIPSIS) return cut;
  return `${tidyHead(cut.slice(0, -ELLIPSIS.length))}${ELLIPSIS}`;
}

/**
 * A rung holds for a row while ListRow can seat its cells uncut and its name still shows the floor
 * once cut — or all of itself, where it is shorter than the floor. What the room holds is measured,
 * not the room: a cut that drops a whole tag keeps less than the room it was given. The whole-word
 * rule then decides only how the name is drawn, never which cells the list keeps.
 */
function holds(cells: RowCells, rung: Rung, width: number): boolean {
  const metadata = metadataAt(cells, rung);
  const ceiling = width - BARE_MODEL_ROW_CHROME - LIST_ROW_LABEL_FLOOR - 1;
  if (getTerminalCellWidth(metadata) > ceiling) return false;
  const room = labelRoom(width, metadata);
  const nameWidth = getTerminalCellWidth(cells.name);
  if (room >= nameWidth) return true;
  const floor = Math.min(nameWidth, MODEL_LABEL_FLOOR);
  if (room < floor) return false;
  return cells.name.includes('/') || getTerminalCellWidth(roomCut(cells.name, room)) >= floor;
}

/** A name's words, each with the separator after it: `claude-fable-5.1` → `claude-`, `fable-`, `5.1`. */
const WORD_RE = /[^\s-]+[\s-]*/g;

/**
 * A cut reads as its own row only while no other name starts, or for a tail ends, with what it
 * kept: `claude-fable-5…` beside `claude-fable-5` could be either, `Ling 3.0 Flash…` three times is
 * all three, and `…(free)` is every free route in the list.
 */
function isAmbiguousCut(label: string, id: string, bases: ReadonlyMap<string, LabelBase>): boolean {
  const head = label.endsWith(ELLIPSIS) ? label.slice(0, -ELLIPSIS.length) : undefined;
  const tail = label.startsWith(ELLIPSIS) ? label.slice(ELLIPSIS.length) : undefined;
  if (head === undefined && tail === undefined) return false;
  for (const [other, { base }] of bases) {
    if (other === id) continue;
    if (head !== undefined && base.startsWith(head)) return true;
    if (tail !== undefined && base.endsWith(tail)) return true;
  }
  return false;
}

/** The longest run of whole trailing words that fits, after the words it gave up. */
function tailLabel(base: string, room: number): string {
  const words = base.match(WORD_RE) ?? [base];
  for (let dropped = 1; dropped < words.length; dropped++) {
    const tail = `${ELLIPSIS}${words.slice(dropped).join('')}`;
    if (getTerminalCellWidth(tail) <= room) return tail;
  }
  return truncateTerminalDisplayTextStart(base, room);
}

/**
 * A label cut to its room must still name its own row. A cut another name also starts with gives
 * up its leading words instead and keeps the ones that tell it apart — `…Fin (free)`,
 * `…Sante (free)`, `…VL (free)`, `…fable-5.1`. Telling rows apart outranks whole words: where no
 * whole-word form does, the head is cut inside a word (`Nemotron 3.5 L…` beside
 * `…Safety (free)`), and where two tails still read alike, each keeps as much of its end as the
 * room holds.
 */
function separateCollisions(
  labels: Map<string, string>,
  bases: ReadonlyMap<string, LabelBase>,
): void {
  for (const [id, label] of labels) {
    const entry = bases.get(id);
    if (entry === undefined || !isAmbiguousCut(label, id, bases)) continue;
    const tail = tailLabel(entry.base, entry.room);
    const head = roomCut(entry.base, entry.room);
    labels.set(id, [tail, head].find((candidate) => !isAmbiguousCut(candidate, id, bases)) ?? tail);
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

/**
 * Every model row of one list at one width, planned together: the column either keeps a cell for
 * every row, names cutting to fit beside it, or drops it for every row — never a row at a time. Then
 * each name is fitted to what its own cells leave, and no two rows are left reading alike.
 */
export function planModelRows(input: {
  rows: readonly RightRow[];
  width: number;
  providerId: string | undefined;
}): ModelRowPlan {
  const modelRows = input.rows.filter((row): row is ModelRow => row.kind === 'model');
  const lines = nameRows(modelRows, input.providerId).map(({ row, name }) => ({
    id: row.model.id,
    cells: cellsOf(row, name),
  }));
  const rung =
    RUNGS.find((candidate) => lines.every((line) => holds(line.cells, candidate, input.width))) ??
    TAGS_ONLY;

  const drawn = lines.map(({ id, cells }) => {
    const metadata = metadataAt(cells, rung);
    return {
      id,
      name: cells.name,
      metadata,
      room: labelRoom(input.width, metadata),
      path: cells.name.includes('/'),
    };
  });
  // The vendor goes from every name or from none, so one list never mixes the two spellings; the
  // row's id and its byline still name it.
  const shedVendor = drawn.some(
    (row) =>
      !row.path && VENDOR_PREFIX_RE.test(row.name) && getTerminalCellWidth(row.name) > row.room,
  );
  const bases = new Map<string, LabelBase>();
  const labels = new Map<string, string>();
  for (const row of drawn) {
    if (row.path) continue;
    const base = shedVendor ? row.name.replace(VENDOR_PREFIX_RE, '') : row.name;
    bases.set(row.id, { base, room: row.room });
    labels.set(row.id, cutLabel(base, row.room));
  }
  separateCollisions(labels, bases);

  return {
    width: input.width,
    rows: new Map(
      drawn.map((row) => [
        row.id,
        {
          label: labels.get(row.id) ?? row.name,
          metadata: row.metadata === '' ? undefined : row.metadata,
          path: row.path,
        },
      ]),
    ),
  };
}
