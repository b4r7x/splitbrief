import { Text } from 'ink';
import type { Theme } from '../../../ui/theme.js';
import type { Config } from '../../../types.js';
import { formatModelName } from '../../../core/providers/models.js';
import { truncate } from '../../../utils/format.js';
import { isCurrentConfig, type PickerOption, type ModelOption } from './picker-catalog.js';

function formatPickerLine(
  label: string,
  badge: string | null,
  version: string | null,
  status: string | null,
  checkmark: boolean,
  maxWidth: number,
): { label: string; suffix: string } {
  const suffixParts: string[] = [];
  if (badge) suffixParts.push(`  ${badge}`);
  if (version) suffixParts.push(` v${version}`);
  if (status) suffixParts.push(` ${status}`);
  if (checkmark) suffixParts.push(' \u2713');

  const fullSuffix = suffixParts.join('');
  const availableForLabel = maxWidth - fullSuffix.length;

  if (label.length <= availableForLabel) {
    return { label, suffix: fullSuffix };
  }

  const suffixNoVersion = suffixParts.filter(p => !p.startsWith(' v')).join('');
  const availableNoVersion = maxWidth - suffixNoVersion.length;
  if (label.length <= availableNoVersion) {
    return { label, suffix: suffixNoVersion };
  }

  const essentialSuffix = (status ? ` ${status}` : '') + (checkmark ? ' \u2713' : '');
  const availableForTruncatedLabel = maxWidth - essentialSuffix.length;
  return {
    label: truncate(label, availableForTruncatedLabel),
    suffix: essentialSuffix,
  };
}

interface ToolRowParams {
  item: PickerOption;
  isCursor: boolean;
  isSelected: boolean;
  maxWidth: number;
  isPlanner: boolean;
  currentCommand: string | undefined;
  config: Config;
  role: 'planner' | 'implementer';
  theme: Theme;
}

export function renderToolRow({
  item,
  isCursor,
  isSelected,
  maxWidth,
  isPlanner,
  currentCommand,
  config,
  role,
  theme: t,
}: ToolRowParams) {
  const isShell = item.kind === 'shell';
  const dimmed = !item.available && !isShell;
  const rawLabel = isShell
    ? (currentCommand ? `shell: ${currentCommand}` : '+ Add custom...')
    : item.displayName;
  const labelColor = dimmed ? t.textDim : isCursor ? t.accent : t.text;
  const showCheck = (isSelected || isCurrentConfig(item, config, role)) && !dimmed;
  const { label, suffix } = formatPickerLine(
    rawLabel,
    isShell ? null : item.badge,
    isShell ? null : (isPlanner ? item.version ?? null : null),
    dimmed ? '(unavailable)' : null,
    showCheck,
    maxWidth,
  );
  return (
    <Text>
      <Text color={labelColor} bold={isCursor && !dimmed}>{label}</Text>
      <Text color={showCheck && suffix.endsWith('\u2713') ? t.success : t.textDim}>
        {suffix.replace(' \u2713', '')}
      </Text>
      {showCheck && <Text color={t.success}> {'\u2713'}</Text>}
    </Text>
  );
}

interface ModelRowParams {
  item: ModelOption;
  isCursor: boolean;
  maxWidth: number;
  currentModel: string | undefined;
  theme: Theme;
}

export function renderModelRow({ item, isCursor, maxWidth, currentModel, theme: t }: ModelRowParams) {
  const isCfgMatch = item.id === currentModel;
  const isCustom = 'isCustom' in item && Boolean(item.isCustom);
  const modelName = formatModelName(item.id);

  const suffixParts: string[] = [];
  if (isCustom) suffixParts.push(' (custom)');
  if (item.isDefault) suffixParts.push(' (default)');
  if (isCfgMatch) suffixParts.push(' \u2713');
  const suffix = suffixParts.join('');
  const truncatedName = truncate(modelName, maxWidth - suffix.length);

  return (
    <Text>
      <Text color={isCursor ? t.accent : t.text} bold={isCursor}>{truncatedName}</Text>
      <Text color={t.textDim}>{suffix.replace(' \u2713', '')}</Text>
      {isCfgMatch && <Text color={t.success}> {'\u2713'}</Text>}
    </Text>
  );
}
