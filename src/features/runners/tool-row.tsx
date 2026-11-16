import { ListRow } from '../../components/list-row/row.js';
import { SOFT_SEP } from '../../core/separators.js';
import { glyph } from '../../lib/glyphs.js';
import { sanitizeTerminalDisplayText } from '../../utils/display-text/sanitize.js';
import { modelRowMatchesId } from './model-catalog/catalog.js';
import type { PickerOption } from './model-catalog/options.js';
import type { RightRow, TreeLead } from './model-catalog/types.js';
import type { ModelRowPlan } from './model-catalog/row-plan.js';
import { formatRouteAuth } from './picker/route-auth.js';
import { formatPickerStatusLabel } from './picker/labels.js';
import { isExpandableRow, type RouteAuthContext } from './right-column/policy.js';

interface ToolRowParams {
  item: PickerOption;
  isCursor: boolean;
  isSelected: boolean;
  maxWidth: number;
  currentCommand: string | undefined;
  currentCommandKind: 'shell' | 'agent' | undefined;
  isContext: boolean;
  /** Whether this list's width seats every status word; see `rowPlansFor`. */
  showStatus: boolean;
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
  showStatus,
}: ToolRowParams) {
  const isCommandBased = item.kind === 'custom-command';
  const showConfiguredCommand = isCommandBased && currentCommandKind && currentCommand;
  const label = isCommandBased
    ? showConfiguredCommand
      ? `${currentCommandKind === 'shell' ? 'output' : 'direct'}${SOFT_SEP}${currentCommand}`
      : ADD_COMMAND_LABEL
    : item.displayName;
  const statusLabel = formatPickerStatusLabel(item.status);
  // A hidden status takes the version with it: a version alone would read as a ready tool.
  const metadata =
    statusLabel === undefined
      ? !isCommandBased && item.available && item.version
        ? item.version
        : undefined
      : showStatus
        ? statusLabel
        : undefined;

  const state = isCursor ? 'active' : isContext ? 'context' : 'default';

  return (
    <ListRow
      label={label}
      state={state}
      metadata={metadata}
      metadataTone={statusLabel !== undefined ? 'warning' : 'dim'}
      selected={isSelected || !!item.isCurrent}
      width={maxWidth}
      // A status outranks the tail of the name it qualifies; a version never does.
      keepWhole={statusLabel === undefined ? 'label' : 'metadata'}
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
  /** The list this row is drawn in, planned at `maxWidth`. */
  plan: ModelRowPlan;
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
        width={maxWidth}
        keepWhole="label"
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
        metadata={word}
        metadataTone={dim ? 'dim' : 'text'}
        trailing={' '}
        selected={currentModel !== undefined && row.variant.fullId === currentModel}
        width={maxWidth}
        // The provider names the route; its sign-in word is the part a narrow row gives up.
        keepWhole="label"
      />
    );
  }
  if (row.kind === 'axis') {
    return (
      <ListRow
        treeLead={treeLead(row.tree, row.last)}
        label={row.axis}
        state={isCursor ? 'active' : 'default'}
        metadata={row.value}
        width={plan.childWidth}
        // The level is what the row steps; its axis name is the part a narrow row gives up.
        keepWhole="metadata"
      />
    );
  }

  const planned = plan.rows.get(row.model.id);
  const label = planned?.label ?? row.model.id;
  return (
    <ListRow
      label={label}
      state={isCursor ? 'active' : 'default'}
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
