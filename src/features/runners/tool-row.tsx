import { ListRow } from '../../components/list-row.js';
import { SOFT_SEP } from '../../components/separators.js';
import { formatModelName } from '../../core/model-display.js';
import { formatContextLength } from '../../core/formatting.js';
import { modelRowMatchesId } from './model-catalog/catalog.js';
import type { PickerOption } from './model-catalog/options.js';
import { isCustomModel, type ModelOption } from './model-catalog/recency.js';
import { formatPickerStatusLabel } from './picker-format.js';

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

interface ModelRowParams {
  item: ModelOption;
  isCursor: boolean;
  maxWidth: number;
  currentModel: string | undefined;
}

export function renderModelRow({ item, isCursor, maxWidth, currentModel }: ModelRowParams) {
  const isCfgMatch = currentModel !== undefined && modelRowMatchesId(item, currentModel);
  const contextStr = item.contextLength ? formatContextLength(item.contextLength) : '';
  // A merged row spans several provider routes; the count signposts that Enter
  // opens the provider chooser instead of confirming directly.
  const providerCount =
    item.variants !== undefined && item.variants.length > 1
      ? `${item.variants.length} providers`
      : '';
  const metadata =
    [
      providerCount,
      contextStr,
      item.isStale || item.membership === 'stale' ? 'Stale' : '',
      isCustomModel(item) ? 'Custom' : '',
      item.isDefault ? 'Default' : '',
    ]
      .filter(Boolean)
      .join(' ') || undefined;

  return (
    <ListRow
      label={formatModelName(item.id)}
      state={isCursor ? 'active' : 'default'}
      defaultLead="dot"
      metadata={metadata}
      selected={isCfgMatch}
      width={maxWidth}
    />
  );
}
