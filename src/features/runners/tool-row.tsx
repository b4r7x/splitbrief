import { Text } from 'ink';
import { ListRow } from '../../components/list-row.js';
import { SOFT_SEP } from '../../components/separators.js';
import { useTheme } from '../../components/theme.js';
import { formatModelName } from '../../core/model-display.js';
import { formatContextLength } from '../../core/formatting.js';
import { glyph, spinnerFrames } from '../../lib/glyphs.js';
import { getTerminalCellWidth, sanitizeTerminalDisplayText } from '../../utils/display-text.js';
import { modelRowMatchesId } from './model-catalog/catalog.js';
import type { PickerOption } from './model-catalog/options.js';
import { formatOptionSummary, isOptionFamily, optionDraftOf } from './model-catalog/option-axis.js';
import type { RightRow } from './model-catalog/rows.js';
import { formatPickerStatusLabel, formatRouteAuth } from './picker-format.js';

interface ToolRowParams {
  item: PickerOption;
  isCursor: boolean;
  isSelected: boolean;
  maxWidth: number;
  currentCommand: string | undefined;
  currentCommandKind: 'shell' | 'agent' | undefined;
  isContext: boolean;
}

const ADD_COMMAND_LABEL = '+ Add custom command…';

export function renderToolRow({
  item,
  isCursor,
  isSelected,
  maxWidth,
  currentCommand,
  currentCommandKind,
  isContext,
}: ToolRowParams) {
  const isCommandBased = item.kind === 'custom-command';
  const showConfiguredCommand = isCommandBased && currentCommandKind && currentCommand;
  const label = isCommandBased
    ? showConfiguredCommand
      ? `${currentCommandKind === 'shell' ? 'output' : 'direct'}${SOFT_SEP}${currentCommand}`
      : ADD_COMMAND_LABEL
    : item.displayName;
  const statusLabel = formatPickerStatusLabel(item.status);
  const metadata =
    statusLabel ?? (!isCommandBased && item.available && item.version ? item.version : undefined);

  const state = isCursor ? 'active' : isContext ? 'context' : 'default';

  return (
    <ListRow
      label={label}
      state={state}
      defaultLead="dot"
      metadata={metadata}
      selected={isSelected || !!item.isCurrent}
      width={maxWidth}
    />
  );
}

/** Below this the route row drops its glyph and its indent; the tag never goes. */
const ROUTE_FLOOR_WIDTH = 26;
/** Below this the value truncates beside the cycle glyph, so it takes those cells instead. */
const AXIS_FLOOR_WIDTH = 23;
/** Below this many cells left for the name the chip loses its word. */
const CHIP_NAME_FLOOR = 12;
/** What a model row spends beside its two columns: lead, metadata gap, disclosure, check. */
const MODEL_ROW_CHROME = 7;

const ROUTE_GLYPHS = {
  configured: 'stageDone',
  missing: 'stagePending',
  unknown: 'statusWarning',
} as const;

function disclosureGlyph(expanded: boolean): string {
  return glyph(expanded ? 'disclosureOpen' : 'disclosureClosed');
}

function disclosureChip(count: number, expanded: boolean, maxWidth: number): string {
  const disclosure = disclosureGlyph(expanded);
  const full = `${count} providers ${disclosure}`;
  const fits = maxWidth - getTerminalCellWidth(full) >= CHIP_NAME_FLOOR;
  return fits ? full : `${count} ${disclosure}`;
}

// The summary is the cheap thing to lose: the disclosure spells it out again one keypress
// away. A family row's provenance word is only ever "Stale", the row's one signal that the
// model may no longer exist, so when no tail fits whole it goes out anyway for ListRow to
// truncate — a clipped "Stal…" still flags the row, an empty column flags nothing.
function optionChip(
  parts: { summary: string; provenance: string; context: string },
  expanded: boolean,
  maxWidth: number,
): { text: string; rest: string; trailing: string } | undefined {
  const { summary, provenance, context } = parts;
  const trailing = disclosureGlyph(expanded);
  const tail = (...items: string[]): string => items.filter(Boolean).join(' ');
  if (expanded) return { text: '', rest: tail(provenance, context), trailing };
  if (summary === '') return undefined;
  const room = maxWidth - CHIP_NAME_FLOOR - MODEL_ROW_CHROME;
  const cells = (chip: { text: string; rest: string }): number =>
    getTerminalCellWidth(tail(chip.text, chip.rest));
  const whole = [
    { text: summary, rest: tail(provenance, context) },
    { text: summary, rest: provenance },
    { text: '', rest: tail(provenance, context) },
    { text: '', rest: provenance },
  ].find((chip) => cells(chip) <= room);
  return { ...(whole ?? { text: '', rest: provenance }), trailing };
}

interface ModelRowParams {
  row: RightRow;
  isCursor: boolean;
  maxWidth: number;
  currentModel: string | undefined;
  /** The section header already names the provenance, so the row must not repeat it. */
  sectioned: boolean;
  optionDraftId?: string | null;
}

export function renderModelRow({
  row,
  isCursor,
  maxWidth,
  currentModel,
  sectioned,
  optionDraftId,
}: ModelRowParams) {
  if (row.kind === 'notice') return <NoticeRow row={row} isCursor={isCursor} />;
  if (row.kind === 'action') return <ActionRow row={row} isCursor={isCursor} />;
  if (row.kind === 'route') return <RouteRow row={row} isCursor={isCursor} width={maxWidth} />;
  if (row.kind === 'axis') {
    const floor = maxWidth < AXIS_FLOOR_WIDTH;
    // The row states whether its ladder can move, so the mark and the byline never
    // disagree. A ladder with nowhere to step drops the mark but keeps its cells, or
    // the sibling rows' trailing column shifts under it.
    return (
      <ListRow
        label={`${glyph(row.last ? 'treeLast' : 'treeBranch')}${glyph('divider')} ${row.axis}`}
        state={isCursor ? 'active' : 'default'}
        defaultLead="blank"
        metadata={row.value}
        trailing={floor ? undefined : row.steps ? glyph('connectorSame') : ' '}
        selected={floor ? undefined : false}
        width={maxWidth}
      />
    );
  }

  const name = row.model.displayName ?? formatModelName(row.model.id);
  const variants = row.model.variants ?? [];
  const routeCount = variants.length;
  const provenance =
    row.provenance === 'Default' || row.provenance === 'Stale'
      ? row.provenance
      : row.provenance === 'Custom' && !sectioned
        ? row.provenance
        : '';
  const optionFamily = isOptionFamily(row.model);
  const summary = optionFamily
    ? formatOptionSummary(optionDraftOf(row.model, optionDraftId ?? currentModel), variants)
    : '';
  const contextStr = formatContextLength(row.model.contextLength);
  const rest = [provenance, contextStr].filter(Boolean).join(' ');
  const chip = optionFamily
    ? optionChip({ summary, provenance, context: contextStr }, row.expanded, maxWidth)
    : undefined;
  const disclosure = optionFamily
    ? (chip?.text ?? '')
    : routeCount > 1
      ? disclosureChip(routeCount, row.expanded, maxWidth)
      : '';
  const metadata = [disclosure, chip?.rest ?? rest].filter(Boolean).join(' ') || undefined;

  return (
    <ListRow
      label={name}
      state={isCursor ? 'active' : 'default'}
      defaultLead="dot"
      metadata={metadata}
      trailing={chip?.trailing}
      selected={currentModel !== undefined && modelRowMatchesId(row.model, currentModel)}
      width={maxWidth}
    />
  );
}

/** The highlight lead keeps the row's cell count, so the columns never shift. */
function leadFor(isCursor: boolean, width: number): string {
  return isCursor ? `${glyph('liveBar')}${' '.repeat(width - 1)}` : ' '.repeat(width);
}

function RouteRow({
  row,
  isCursor,
  width,
}: {
  row: Extract<RightRow, { kind: 'route' }>;
  isCursor: boolean;
  width: number;
}) {
  const t = useTheme();
  const floor = width < ROUTE_FLOOR_WIDTH;
  const { word, glyph: mark } = formatRouteAuth({ auth: row.auth, floor });
  const tag = sanitizeTerminalDisplayText(row.variant.tag);
  const lead = leadFor(isCursor, floor ? 2 : 4);
  const marker = mark === undefined ? '' : `${glyph(ROUTE_GLYPHS[mark])} `;
  // The sibling routes share one word column, so a short tag is padded out to
  // the widest of them; at the floor there is no room to spend on alignment.
  const paddedTag =
    floor || word === undefined
      ? tag
      : tag + ' '.repeat(Math.max(0, row.tagWidth - getTerminalCellWidth(tag)));
  return (
    <Text color={isCursor ? t.accent : t.textDim} wrap="truncate-end">
      {`${lead}${marker}${paddedTag}${word === undefined ? '' : `  ${word}`}`}
    </Text>
  );
}

function NoticeRow({
  row,
  isCursor,
}: {
  row: Extract<RightRow, { kind: 'notice' }>;
  isCursor: boolean;
}) {
  const t = useTheme();
  const mark = row.lane === 'pending' ? (spinnerFrames()[0] ?? '') : glyph('statusFailed');
  return (
    <Text color={isCursor ? t.accent : t.textDim} dimColor wrap="truncate-end">
      {`${leadFor(isCursor, 2)}${mark} ${row.text}`}
    </Text>
  );
}

function ActionRow({
  row,
  isCursor,
}: {
  row: Extract<RightRow, { kind: 'action' }>;
  isCursor: boolean;
}) {
  const t = useTheme();
  return (
    <Text color={isCursor ? t.accent : t.text} wrap="truncate-end">
      {`${leadFor(isCursor, 2)}${glyph('disclosureClosed')} ${row.text}`}
    </Text>
  );
}
