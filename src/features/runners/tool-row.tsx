import { ListRow } from '../../components/list-row.js';
import { isProviderLocal } from '../../core/providers/catalog.js';
import { formatModelName } from '../../core/model-display.js';
import { formatContextLength } from '../../core/formatting.js';
import type { PickerOption, ModelOption } from './model-catalog.js';
import { isCustomModel } from './model-catalog.js';

interface ToolRowParams {
  item: PickerOption;
  isCursor: boolean;
  isSelected: boolean;
  maxWidth: number;
  currentCommand: string | undefined;
  currentCommandKind: 'shell' | 'agent' | undefined;
}

export function renderToolRow({
  item,
  isCursor,
  isSelected,
  maxWidth,
  currentCommand,
  currentCommandKind,
}: ToolRowParams) {
  const isCommandBased = item.kind === 'shell' || item.kind === 'agent';
  const dimmed = !item.available && !isCommandBased && item.kind !== 'agent-sdk';
  const isLocal = isProviderLocal(item.id);
  const showConfiguredCommand =
    isCommandBased && currentCommandKind === item.kind && currentCommand;
  const label = isCommandBased
    ? showConfiguredCommand
      ? `${item.kind}: ${currentCommand}`
      : '+ add custom…'
    : item.displayName;
  const status = dimmed ? (isLocal ? 'no models' : 'unavailable') : undefined;
  const metadata = status ?? (!isCommandBased ? (item.version ?? undefined) : undefined);

  return (
    <ListRow
      label={label}
      state={isCursor ? 'active' : 'default'}
      defaultLead="dot"
      metadata={metadata}
      selected={isSelected && !dimmed}
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
  const isCfgMatch = item.id === currentModel;
  const modelName = formatModelName(item.id);
  const isAutoModel = item.isDefault && item.id === 'auto';
  const contextStr =
    !isAutoModel && item.contextLength ? formatContextLength(item.contextLength) : '';
  const badge = isCustomModel(item) ? 'custom' : isAutoModel ? 'default' : '';
  const metadata = [contextStr, badge].filter(Boolean).join(' ') || undefined;

  return (
    <ListRow
      label={modelName}
      state={isCursor ? 'active' : 'default'}
      defaultLead="dot"
      metadata={metadata}
      selected={isCfgMatch}
      width={maxWidth}
    />
  );
}
