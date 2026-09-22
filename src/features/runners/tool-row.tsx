import { ListRow } from '../../components/list-row.js';
import { SOFT_SEP } from '../../core/separators.js';
import { getTheme } from '../../components/theme.js';
import { glyph } from '../../lib/glyphs.js';
import { sanitizeTerminalDisplayText } from '../../utils/display-text.js';
import { modelRowMatchesId } from './model-catalog/catalog.js';
import type { PickerOption } from './model-catalog/options.js';
import {
  AUTH_METHOD_WORDS,
  AUTH_ROW_LABEL,
  AUTH_UNPROVEN_WORD,
  type RightRow,
  type TreeLead,
} from './model-catalog/rows.js';
import { planModelRows, type ModelRowPlan } from './model-row-plan.js';
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

/** The connector this row hangs from: three cells per level, the parent's spine when it continues. */
function treeLead(tree: TreeLead, last: boolean): string {
  const branch = `${glyph(last ? 'treeLast' : 'treeBranch')}${glyph('divider')} `;
  if (tree.depth === 1) return branch;
  return `${tree.parentContinues ? `${glyph('treeMid')}  ` : '   '}${branch}`;
}

interface ModelRowParams {
  row: RightRow;
  isCursor: boolean;
  maxWidth: number;
  currentModel: string | undefined;
  /** What the tool's credential listing says; the chevron rule needs it. */
  auth: RouteAuthContext;
  /** The list this row is drawn in, planned at `maxWidth`; a row drawn alone is a list of one. */
  plan?: ModelRowPlan | undefined;
}

export function renderModelRow({
  row,
  isCursor,
  maxWidth,
  currentModel,
  auth,
  plan,
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
  if (row.kind === 'auth') {
    // The value is the state, so the row carries no check; a row with nothing to
    // choose also carries no disclosure, and so says nothing about being steerable.
    const word = AUTH_METHOD_WORDS[row.method];
    return (
      <ListRow
        treeLead={treeLead(row.tree, row.last)}
        label={`${AUTH_ROW_LABEL} ${row.unproven ? AUTH_UNPROVEN_WORD : word}`}
        state={isCursor ? 'active' : 'default'}
        defaultLead="blank"
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

  const planned = (plan ?? planModelRows({ rows: [row], width: maxWidth })).rows.get(row.model.id);
  const label = planned?.label ?? row.model.id;
  return (
    <ListRow
      label={label}
      state={isCursor ? 'active' : 'default'}
      defaultLead="dot"
      // A namespaced id (`anthropic/claude-opus-4.5`) is named by its tail, and a cut inside a
      // segment names nothing: it gives up whole leading segments instead.
      labelTruncate={planned?.path === true ? 'path' : 'end'}
      metadata={planned?.metadata}
      width={maxWidth}
      trailing={
        isExpandableRow(row, auth)
          ? glyph(row.expanded ? 'disclosureOpen' : 'disclosureClosed')
          : ' '
      }
      selected={currentModel !== undefined && modelRowMatchesId(row.model, currentModel)}
    />
  );
}
