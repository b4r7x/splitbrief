import { ListRow } from '../../components/list-row.js';
import { SOFT_SEP } from '../../components/separators.js';
import { getTheme } from '../../components/theme.js';
import { formatContextLength } from '../../core/formatting.js';
import { formatModelName } from '../../core/model-display.js';
import { isAutomaticModel } from '../../core/providers/automatic-model.js';
import { glyph } from '../../lib/glyphs.js';
import { getTerminalCellWidth, sanitizeTerminalDisplayText } from '../../utils/display-text.js';
import { modelRowMatchesId } from './model-catalog/catalog.js';
import type { PickerOption } from './model-catalog/options.js';
import { isOptionFamily, routePrefixesOf } from './model-catalog/option-axis.js';
import { AUTO_ROW_METADATA, type RightRow, type TreeLead } from './model-catalog/rows.js';
import { formatPickerStatusLabel, formatRouteAuth } from './picker-format.js';
import { isExpandableRow, type RouteAuthContext } from './right-column-policy.js';

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
      defaultLead={isCommandBased && !showConfiguredCommand ? 'blank' : 'dot'}
      metadata={metadata}
      metadataColor={statusLabel === undefined ? undefined : getTheme().warning}
      selected={isSelected || !!item.isCurrent}
      width={maxWidth}
    />
  );
}

/** The label never drops below this many cells; the count pays first. */
const NAME_MIN_CELLS = 12;
/** What a model row spends beside its two columns: lead, metadata gap, disclosure, check. */
const MODEL_ROW_CHROME = 7;

/** The connector this row hangs from: three cells per level, the parent's spine when it continues. */
function treeLead(tree: TreeLead, last: boolean): string {
  const branch = `${glyph(last ? 'treeLast' : 'treeBranch')}${glyph('divider')} `;
  if (tree.depth === 1) return branch;
  return `${tree.parentContinues ? `${glyph('treeMid')}  ` : '   '}${branch}`;
}

/** The label's budget is protected first: the count keeps its word or it goes; a bare digit is not a value. */
function countChip(count: number, word: string, tail: string, maxWidth: number): string {
  const spent = MODEL_ROW_CHROME + NAME_MIN_CELLS + getTerminalCellWidth(tail);
  const room = maxWidth - spent - (tail === '' ? 0 : 1);
  const full = `${count} ${word}`;
  return getTerminalCellWidth(full) <= room ? full : '';
}

interface ModelRowParams {
  row: RightRow;
  isCursor: boolean;
  maxWidth: number;
  currentModel: string | undefined;
  /** The section header already names the provenance, so the row must not repeat it. */
  sectioned: boolean;
  /** What the tool's credential listing says; the chevron rule needs it. */
  auth: RouteAuthContext;
}

export function renderModelRow({
  row,
  isCursor,
  maxWidth,
  currentModel,
  sectioned,
  auth,
}: ModelRowParams) {
  if (row.kind === 'action') {
    return (
      <ListRow
        label={row.text}
        state={isCursor ? 'active' : 'default'}
        defaultLead="blank"
        width={maxWidth}
      />
    );
  }
  if (row.kind === 'route') {
    const { word, dim } = formatRouteAuth({ auth: row.auth });
    return (
      <ListRow
        treeLead={treeLead(row.tree, row.last)}
        label={sanitizeTerminalDisplayText(row.variant.tag)}
        state={isCursor ? 'active' : 'default'}
        defaultLead="blank"
        metadata={word}
        metadataColor={dim ? undefined : getTheme().text}
        trailing={' '}
        selected={currentModel !== undefined && row.variant.fullId === currentModel}
        width={maxWidth}
      />
    );
  }
  if (row.kind === 'axis') {
    // The cell stays even when the row cannot step, or the sibling rows' trailing column shifts under it.
    return (
      <ListRow
        treeLead={treeLead(row.tree, row.last)}
        label={row.axis}
        state={isCursor ? 'active' : 'default'}
        defaultLead="blank"
        metadata={row.value}
        trailing={' '}
        selected={false}
        width={maxWidth}
      />
    );
  }

  const name = row.model.displayName ?? formatModelName(row.model.id);
  const variants = row.model.variants ?? [];
  const routeCount = routePrefixesOf(variants).length;
  const provenance =
    row.provenance === 'Stale' || (row.provenance === 'Custom' && !sectioned) ? row.provenance : '';
  const detail = isAutomaticModel(row.model.id)
    ? AUTO_ROW_METADATA
    : (row.model.detail ?? formatContextLength(row.model.contextLength));
  const tail = [provenance, row.model.vendorTag ?? '', detail].filter(Boolean).join(' ');
  const chip = isOptionFamily(row.model)
    ? countChip(variants.length, 'options', tail, maxWidth)
    : routeCount > 1
      ? countChip(routeCount, 'providers', tail, maxWidth)
      : '';
  const metadata = [chip, tail].filter(Boolean).join(' ') || undefined;

  return (
    <ListRow
      label={name}
      state={isCursor ? 'active' : 'default'}
      defaultLead="dot"
      metadata={metadata}
      trailing={
        isExpandableRow(row, auth)
          ? glyph(row.expanded ? 'disclosureOpen' : 'disclosureClosed')
          : ' '
      }
      selected={currentModel !== undefined && modelRowMatchesId(row.model, currentModel)}
      width={maxWidth}
    />
  );
}
