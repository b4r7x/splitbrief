import { LIST_ROW_LABEL_FLOOR, ListRow } from '../../components/list-row.js';
import { SOFT_SEP } from '../../components/separators.js';
import { getTheme } from '../../components/theme.js';
import { formatContextLength } from '../../core/formatting.js';
import { formatModelName } from '../../core/model-display.js';
import { isAutoCheapestModel, isAutomaticModel } from '../../core/providers/automatic-model.js';
import { glyph } from '../../lib/glyphs.js';
import {
  getTerminalCellWidth,
  sanitizeTerminalDisplayText,
  truncateTerminalDisplayText,
} from '../../utils/display-text.js';
import { modelRowMatchesId } from './model-catalog/catalog.js';
import type { PickerOption } from './model-catalog/options.js';
import { isOptionFamily, routePrefixesOf } from './model-catalog/option-axis.js';
import { stripModelNamespace } from './model-catalog/provider-axis.js';
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

/** What a model row spends beside its two columns: lead, metadata gap, disclosure, check. */
const MODEL_ROW_CHROME = 7;
/** The same row with no metadata at all: the gap goes with it. */
const BARE_MODEL_ROW_CHROME = MODEL_ROW_CHROME - 1;

/** The connector this row hangs from: three cells per level, the parent's spine when it continues. */
function treeLead(tree: TreeLead, last: boolean): string {
  const branch = `${glyph(last ? 'treeLast' : 'treeBranch')}${glyph('divider')} `;
  if (tree.depth === 1) return branch;
  return `${tree.parentContinues ? `${glyph('treeMid')}  ` : '   '}${branch}`;
}

/**
 * The name's own width is what every other cell is measured against: a name cut to `Sonnet …` loses
 * the `(1M)` the row exists to distinguish, and three rows that keep `forces the 1M w…` instead say
 * the same thing three times. So the cells are given up in one order — the catalog id first (a
 * truncated id names a model that does not exist), then the count (a bare digit is not a value),
 * then the description — until what is left fits beside the whole name. Only the provenance and
 * vendor tags stay: they are states, not prose, and ListRow's own floor already seats them.
 */
function fitModelMetadata(input: {
  name: string;
  chip: string;
  tags: string;
  detail: string;
  catalogId: string | undefined;
  maxWidth: number;
}): string | undefined {
  const { chip, tags, detail, catalogId } = input;
  const body = [tags, detail].filter(Boolean).join(' ');
  const withId =
    catalogId === undefined ? body : body === '' ? catalogId : `${body}${SOFT_SEP}${catalogId}`;
  const rungs = [[chip, withId], [chip, body], [body], [tags]].map((parts) =>
    parts.filter(Boolean).join(' '),
  );
  // ListRow keeps the label's floor whatever the metadata asks for, so a short name does not hand
  // the rest of the row to the metadata: past this ceiling the cell would be cut, not seated.
  const ceiling = input.maxWidth - BARE_MODEL_ROW_CHROME - LIST_ROW_LABEL_FLOOR - 1;
  // Giving a cell up only helps while it buys the whole name. A name with no separator has no
  // shorter legible form, so once it is going to be cut anyway the cells stay and inform; a path
  // name spends every cell it is given on another whole segment, so it always takes the room.
  const nameWidth = getTerminalCellWidth(input.name);
  const savesTheName =
    input.name.includes('/') || input.maxWidth - BARE_MODEL_ROW_CHROME >= nameWidth;
  const room = savesTheName
    ? Math.min(input.maxWidth - MODEL_ROW_CHROME - nameWidth, ceiling)
    : ceiling;
  const fitted = rungs.find((line) => getTerminalCellWidth(line) <= room);
  // Nothing fits beside the whole name: the tags are the floor, and ListRow's own metadata floor
  // seats them. A row with no tags shows no metadata rather than a cut count or a cut description.
  return (fitted ?? rungs.at(-1)) || undefined;
}

/** Two cells buy an ellipsis and one character, which says nothing: the row drops the policy. */
const MIN_POLICY_DETAIL_CELLS = 2;

/**
 * The policy row's label is its whole identity, so it holds a fixed column and
 * the one-line policy truncates into whatever is left — never the reverse.
 */
function policyDetailTail(
  detail: string,
  labelWidth: number,
  maxWidth: number,
): string | undefined {
  const budget = maxWidth - MODEL_ROW_CHROME - labelWidth;
  return budget <= MIN_POLICY_DETAIL_CELLS
    ? undefined
    : truncateTerminalDisplayText(detail, budget);
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
  /** The leading path segment every namespaced row in this list shares, dropped from the label. */
  namespace?: string | undefined;
}

export function renderModelRow({
  row,
  isCursor,
  maxWidth,
  currentModel,
  sectioned,
  auth,
  namespace,
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

  const name =
    row.model.displayName ?? formatModelName(stripModelNamespace(row.model.id, namespace));
  const variants = row.model.variants ?? [];
  const routeCount = routePrefixesOf(variants).length;
  const provenance =
    row.provenance === 'Stale' || (row.provenance === 'Custom' && !sectioned) ? row.provenance : '';
  const isPolicyRow = isAutoCheapestModel(row.model.id);
  const detail = isAutomaticModel(row.model.id)
    ? AUTO_ROW_METADATA
    : (row.model.detail ?? formatContextLength(row.model.contextLength));
  const chip = isOptionFamily(row.model)
    ? `${variants.length} options`
    : routeCount > 1
      ? `${routeCount} providers`
      : '';
  const metadata = fitModelMetadata({
    name,
    chip,
    tags: [provenance, row.model.vendorTag ?? ''].filter(Boolean).join(' '),
    detail,
    catalogId: row.model.catalogModelId,
    maxWidth,
  });
  // The policy row keeps its fixed label column only while every cell of row
  // furniture fits beside it; below that the row takes the standard path, where
  // the name truncates like any other long name rather than eating the caret
  // lead and the check.
  const nameWidth = getTerminalCellWidth(name);
  const protectedLabel = isPolicyRow && maxWidth - MODEL_ROW_CHROME >= nameWidth;
  const policyDetail = protectedLabel ? policyDetailTail(detail, nameWidth, maxWidth) : undefined;

  return (
    <ListRow
      label={name}
      state={isCursor ? 'active' : 'default'}
      defaultLead="dot"
      // A namespaced id (`anthropic/claude-opus-4.5`) is named by its tail, and a cut inside a
      // segment names nothing: it gives up whole leading segments instead.
      labelTruncate={name.includes('/') ? 'path' : 'end'}
      metadata={protectedLabel ? policyDetail : metadata}
      width={maxWidth}
      labelWidth={protectedLabel ? nameWidth : undefined}
      trailing={
        isExpandableRow(row, auth)
          ? glyph(row.expanded ? 'disclosureOpen' : 'disclosureClosed')
          : ' '
      }
      selected={currentModel !== undefined && modelRowMatchesId(row.model, currentModel)}
    />
  );
}
