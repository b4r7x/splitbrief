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
import type { RightRow } from './model-catalog/rows.js';
import { formatPickerStatusLabel, formatRouteAuth } from './picker-format.js';

interface ToolRowParams {
  item: PickerOption;
  isCursor: boolean;
  isSelected: boolean;
  maxWidth: number;
  currentCommand: string | undefined;
  currentCommandKind: 'shell' | 'agent' | undefined;
}

const ADD_COMMAND_LABEL = '+ Add custom command…';

export function renderToolRow({
  item,
  isCursor,
  isSelected,
  maxWidth,
  currentCommand,
  currentCommandKind,
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

  return (
    <ListRow
      label={label}
      state={isCursor ? 'active' : 'default'}
      defaultLead="dot"
      metadata={metadata}
      selected={isSelected || !!item.isCurrent}
      width={maxWidth}
    />
  );
}

/** Below this the route row drops its glyph and its indent; the tag never goes. */
const ROUTE_FLOOR_WIDTH = 26;
/** Below this many cells left for the name the chip loses its word. */
const CHIP_NAME_FLOOR = 12;

const ROUTE_GLYPHS = {
  configured: 'stageDone',
  missing: 'stagePending',
  unknown: 'statusWarning',
} as const;

function providerChip(count: number, expanded: boolean, maxWidth: number): string {
  const disclosure = glyph(expanded ? 'disclosureOpen' : 'disclosureClosed');
  const full = `${count} providers ${disclosure}`;
  const fits = maxWidth - getTerminalCellWidth(full) >= CHIP_NAME_FLOOR;
  return fits ? full : `${count} ${disclosure}`;
}

interface ModelRowParams {
  row: RightRow;
  isCursor: boolean;
  maxWidth: number;
  currentModel: string | undefined;
  /** The section header already names the provenance, so the row must not repeat it. */
  sectioned: boolean;
}

export function renderModelRow({
  row,
  isCursor,
  maxWidth,
  currentModel,
  sectioned,
}: ModelRowParams) {
  if (row.kind === 'notice') return <NoticeRow row={row} isCursor={isCursor} />;
  if (row.kind === 'route') return <RouteRow row={row} isCursor={isCursor} width={maxWidth} />;

  const name = row.model.displayName ?? formatModelName(row.model.id);
  const routeCount = row.model.variants?.length ?? 0;
  const contextStr = row.model.contextLength ? formatContextLength(row.model.contextLength) : '';
  const carriesWord = row.provenance === 'Default' || !sectioned;
  const metadata =
    [
      routeCount > 1 ? providerChip(routeCount, row.expanded, maxWidth) : '',
      carriesWord ? row.provenance : '',
      contextStr,
    ]
      .filter(Boolean)
      .join(' ') || undefined;

  return (
    <ListRow
      label={name}
      state={isCursor ? 'active' : 'default'}
      defaultLead="dot"
      metadata={metadata}
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
