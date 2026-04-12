import { Text } from 'ink';
import type { Theme } from '../../../ui/theme.js';
import { formatModelName } from '../../../core/providers/models.js';
import { formatContextLength, formatPrice } from '../../../core/providers/model-metadata.js';
import { truncate } from '../../../utils/format.js';
import type { PickerOption, ModelOption } from './picker-catalog.js';
import { isCustomModel } from './picker-catalog.js';

const CHECKMARK_WIDTH = 2;

function formatPickerLine(
  label: string,
  badge: string | null,
  version: string | null,
  status: string | null,
  checkmark: boolean,
  maxWidth: number,
): { label: string; suffix: string; checkmark: boolean } {
  const suffixParts: string[] = [];
  if (badge) suffixParts.push(`  ${badge}`);
  if (version) suffixParts.push(` v${version}`);
  if (status) suffixParts.push(` ${status}`);

  const checkmarkWidth = checkmark ? CHECKMARK_WIDTH : 0;
  const fullSuffix = suffixParts.join('');
  const availableForLabel = maxWidth - fullSuffix.length - checkmarkWidth;

  if (label.length <= availableForLabel) {
    return { label, suffix: fullSuffix, checkmark };
  }

  const suffixNoVersion = suffixParts.filter(p => !p.startsWith(' v')).join('');
  const availableNoVersion = maxWidth - suffixNoVersion.length - checkmarkWidth;
  if (label.length <= availableNoVersion) {
    return { label, suffix: suffixNoVersion, checkmark };
  }

  const essentialSuffix = status ? ` ${status}` : '';
  const availableForTruncatedLabel = maxWidth - essentialSuffix.length - checkmarkWidth;
  return {
    label: truncate(label, availableForTruncatedLabel),
    suffix: essentialSuffix,
    checkmark,
  };
}

interface ToolRowParams {
  item: PickerOption;
  isCursor: boolean;
  isSelected: boolean;
  maxWidth: number;
  isPlanner: boolean;
  currentCommand: string | undefined;
  theme: Theme;
}

export function renderToolRow({
  item,
  isCursor,
  isSelected,
  maxWidth,
  isPlanner,
  currentCommand,
  theme: t,
}: ToolRowParams) {
  const isCommandBased = item.kind === 'shell' || item.kind === 'agent';
  const dimmed = !item.available && !isCommandBased && item.kind !== 'agent-sdk';
  const rawLabel = isCommandBased
    ? (currentCommand ? `${item.kind}: ${currentCommand}` : '+ Add custom...')
    : item.displayName;
  const labelColor = dimmed ? t.textDim : isCursor ? t.accent : t.text;
  const showCheck = (isSelected || item.isCurrent === true) && !dimmed;
  const { label, suffix, checkmark } = formatPickerLine(
    rawLabel,
    isCommandBased ? null : item.badge,
    isCommandBased ? null : (isPlanner ? item.version ?? null : null),
    dimmed ? '(unavailable)' : null,
    showCheck,
    maxWidth,
  );
  return (
    <Text>
      <Text color={labelColor} bold={isCursor && !dimmed}>{label}</Text>
      <Text color={t.textDim}>{suffix}</Text>
      {checkmark && <Text color={t.success}> {'\u2713'}</Text>}
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
  const modelName = formatModelName(item.id);

  const metaParts: string[] = [];
  if (item.contextLength) {
    metaParts.push(formatContextLength(item.contextLength));
  }
  if (item.pricingInput !== undefined && !item.isFree) {
    metaParts.push(formatPrice(item.pricingInput));
  }
  const metaSuffix = metaParts.length > 0 ? ` ${metaParts.join(' | ')}` : '';

  const badge = isCustomModel(item) ? '(custom)' : null;
  const status = item.isDefault ? '(default)' : null;

  const freeWidth = item.isFree ? 6 : 0;
  const effectiveMaxWidth = maxWidth - freeWidth - metaSuffix.length;

  const { label, suffix, checkmark } = formatPickerLine(modelName, badge, null, status, isCfgMatch, effectiveMaxWidth);

  return (
    <Text>
      {item.isFree && <Text color={t.success} bold> FREE </Text>}
      <Text color={isCursor ? t.accent : t.text} bold={isCursor}>{label}</Text>
      <Text color={t.textDim}>{suffix}</Text>
      <Text color={t.textDim} dimColor>{metaSuffix}</Text>
      {checkmark && <Text color={t.success}> {'\u2713'}</Text>}
    </Text>
  );
}
