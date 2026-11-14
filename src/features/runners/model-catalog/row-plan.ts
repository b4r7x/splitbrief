import { LIST_ROW_LABEL_FLOOR } from '../../../components/list-row/fit.js';
import { formatContextLength } from '../../../core/formatting.js';
import { isAutomaticModel } from '../../../core/providers/automatic-model.js';
import { formatModelName } from '../../../core/providers/model-display.js';
import { SOFT_SEP } from '../../../core/separators.js';
import { getTerminalCellWidth } from '../../../utils/display-text/width.js';
import { roomCut, twinFloorOf, type LabelBase, cutLabel, separateCollisions } from './label-cut.js';
import { isOptionFamily, routePrefixesOf } from './option-axis.js';
import { modelIdUnderProvider } from './provider-axis.js';
import { sectionOf, AUTO_ROW_METADATA } from './rows.js';
import type { RightRow } from './types.js';

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
  readonly childWidth: number;
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

/**
 * A rung holds for a row while ListRow can seat its cells uncut and its name still shows the floor
 * once cut — or all of itself, where it is shorter than the floor. What the room holds is measured,
 * not the room: a cut that drops a whole tag keeps less than the room it was given. The whole-word
 * rule then decides only how the name is drawn, never which cells the list keeps.
 */
function holds(cells: RowCells, rung: Rung, width: number, twinFloor = 0): boolean {
  const metadata = metadataAt(cells, rung);
  const ceiling = width - BARE_MODEL_ROW_CHROME - LIST_ROW_LABEL_FLOOR - 1;
  if (getTerminalCellWidth(metadata) > ceiling) return false;
  const room = labelRoom(width, metadata);
  const nameWidth = getTerminalCellWidth(cells.name);
  if (room >= nameWidth) return true;
  if (room < twinFloor) return false;
  const floor = Math.min(nameWidth, MODEL_LABEL_FLOOR);
  if (room < floor) return false;
  return cells.name.includes('/') || getTerminalCellWidth(roomCut(cells.name, room)) >= floor;
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
  const childRoom = input.rows.reduce((room, row) => {
    if (row.kind !== 'axis') return room;
    return Math.max(
      room,
      2 + row.tree.depth * 3 + getTerminalCellWidth(row.axis) + 1 + getTerminalCellWidth(row.value),
    );
  }, 0);
  const childWidth =
    [input.width - 4, input.width - 2, input.width].find((width) => width >= childRoom) ??
    input.width;
  const modelRows = input.rows.filter((row): row is ModelRow => row.kind === 'model');
  const lines = nameRows(modelRows, input.providerId).map(({ row, name }) => ({
    id: row.model.id,
    cells: cellsOf(row, name),
  }));
  const names = new Map(lines.map(({ id, cells }) => [id, { base: cells.name, room: 0 }]));
  const twinFloors = new Map(lines.map(({ id }) => [id, twinFloorOf(id, names)]));
  // A twin's model outranks every cell beside it; where no set of cells leaves it, the floor rules.
  const rung =
    RUNGS.find((candidate) =>
      lines.every((line) => holds(line.cells, candidate, input.width, twinFloors.get(line.id))),
    ) ??
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
    childWidth,
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
