import type { PickerEntry } from './two-column-picker/types.js';
import { glyph } from '../../lib/glyphs.js';
import { sanitizeTerminalDisplayText } from '../../utils/display-text/sanitize.js';
import { modelRowMatchesId } from './model-catalog/catalog.js';
import type { PickerOption } from './model-catalog/options.js';
import type { RightRow, TreeLead } from './model-catalog/types.js';
import type { ModelRowPlan } from './model-catalog/row-plan.js';
import { formatRouteAuth } from './picker/route-auth.js';
import { formatPickerStatusLabel } from '../../core/readiness/cli-remediation.js';
import { isExpandableRow, type RouteAuthContext } from './right-column/policy.js';

interface ToolRowParams {
  item: PickerOption;
  isCursor: boolean;
  isSelected: boolean;
  isContext: boolean;
  /** Whether this list's width seats every status word; see `rowPlansFor`. */
  showStatus: boolean;
}

const ADD_COMMAND_LABEL = '+ Add custom command…';

export function toolRowModel({
  item,
  isCursor,
  isSelected,
  isContext,
  showStatus,
}: ToolRowParams): PickerEntry {
  const label = item.kind === 'custom-command' ? ADD_COMMAND_LABEL : item.displayName;
  const statusLabel = formatPickerStatusLabel(item.status);
  // A hidden status takes the version with it: a version alone would read as a ready tool.
  const metadata =
    statusLabel === undefined
      ? item.available
        ? item.version
        : undefined
      : showStatus
        ? statusLabel
        : undefined;

  const state = isCursor ? 'active' : isContext ? 'context' : 'default';

  return {
    name: label,
    state,
    metadata,
    metadataTone: statusLabel ? 'warning' : 'textDim',
    checked: isSelected || !!item.isCurrent,
    keepWhole: statusLabel ? 'metadata' : 'label',
  };
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
  currentModel: string | undefined;
  /** What the tool's credential listing says; the chevron rule needs it. */
  auth: RouteAuthContext;
  /** The list this row is drawn in, planned at `maxWidth`. */
  plan: ModelRowPlan;
}

export function modelRowModel({
  row,
  isCursor,
  currentModel,
  auth,
  plan,
}: ModelRowParams): PickerEntry {
  const state = isCursor ? 'active' : 'default';
  if (row.kind === 'action') {
    return { name: row.text, state, keepWhole: 'label' };
  }
  if (row.kind === 'route') {
    const { word, dim } = formatRouteAuth({ auth: row.auth });
    return {
      treeLead: treeLead(row.tree, row.last),
      name: sanitizeTerminalDisplayText(row.variant.tag),
      state,
      metadata: word,
      metadataTone: dim ? 'textDim' : 'text',
      trailing: ' ',
      checked: currentModel !== undefined && row.variant.fullId === currentModel,
      keepWhole: 'label',
    };
  }
  if (row.kind === 'axis') {
    return {
      treeLead: treeLead(row.tree, row.last),
      name: row.axis,
      state,
      metadata: row.value,
      maxWidth: plan.childWidth,
      keepWhole: 'metadata',
    };
  }

  const planned = plan.rows.get(row.model.id);
  const label = planned?.label ?? row.model.id;
  return {
    name: label,
    state,
    nameTruncate: planned?.path ? 'path' : undefined,
    metadata: planned?.metadata,
    trailing: isExpandableRow(row, auth)
      ? glyph(row.expanded ? 'disclosureOpen' : 'disclosureClosed')
      : ' ',
    checked: currentModel !== undefined && modelRowMatchesId(row.model, currentModel),
  };
}
