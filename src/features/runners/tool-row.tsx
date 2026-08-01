import { ListRow } from '../../components/list-row.js';
import { formatModelName } from '../../core/model-display.js';
import { formatContextLength } from '../../core/formatting.js';
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

const COMMAND_LABELS = {
  shell: '+ Add shell command…',
  agent: '+ Add agent command…',
} satisfies Record<'shell' | 'agent', string>;

export function renderToolRow({
  item,
  isCursor,
  isSelected,
  maxWidth,
  currentCommand,
  currentCommandKind,
}: ToolRowParams) {
  const isCommandBased = item.kind === 'shell' || item.kind === 'agent';
  const showConfiguredCommand =
    isCommandBased && currentCommandKind === item.kind && currentCommand;
  const label = isCommandBased
    ? showConfiguredCommand
      ? `${item.kind}: ${currentCommand}`
      : item.kind === 'shell'
        ? COMMAND_LABELS.shell
        : COMMAND_LABELS.agent
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
  const isCfgMatch = item.id === currentModel;
  const modelName = formatModelName(item.id);
  const contextStr = item.contextLength ? formatContextLength(item.contextLength) : '';
  const badge = isCustomModel(item) ? 'Custom' : item.isDefault ? 'Default' : '';
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
