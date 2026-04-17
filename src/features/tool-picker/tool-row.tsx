import { Text } from "ink";
import type { Theme } from "../../components/theme.js";
import { isProviderLocal } from "../../core/providers/index.js";
import { formatModelName } from "../../core/model-display.js";
import { formatContextLength, truncate } from "../../utils/format-numbers.js";
import type { PickerOption, ModelOption } from "./picker-model-catalog.js";
import { isCustomModel } from "./picker-model-catalog.js";

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

  const fullSuffix = suffixParts.join("");
  const availableForLabel = maxWidth - fullSuffix.length - CHECKMARK_WIDTH;

  if (label.length <= availableForLabel) {
    return { label, suffix: fullSuffix, checkmark };
  }

  const suffixNoVersion = suffixParts
    .filter((p) => !p.startsWith(" v"))
    .join("");
  const availableNoVersion = maxWidth - suffixNoVersion.length - CHECKMARK_WIDTH;
  if (label.length <= availableNoVersion) {
    return { label, suffix: suffixNoVersion, checkmark };
  }

  const essentialSuffix = status ? ` ${status}` : "";
  const availableForTruncatedLabel =
    maxWidth - essentialSuffix.length - CHECKMARK_WIDTH;
  return {
    label: truncate(label, availableForTruncatedLabel),
    suffix: essentialSuffix,
    checkmark,
  };
}

function padBetween(left: string, right: string, totalWidth: number): string {
  const gap = totalWidth - left.length - right.length;
  return gap > 0 ? ' '.repeat(gap) : ' ';
}

interface ToolRowParams {
  item: PickerOption;
  isCursor: boolean;
  isSelected: boolean;
  maxWidth: number;
  currentCommand: string | undefined;
  currentCommandKind: 'shell' | 'agent' | undefined;
  theme: Theme;
}

export function renderToolRow({
  item,
  isCursor,
  isSelected,
  maxWidth,
  currentCommand,
  currentCommandKind,
  theme: t,
}: ToolRowParams) {
  const isCommandBased = item.kind === "shell" || item.kind === "agent";
  const dimmed =
    !item.available && !isCommandBased && item.kind !== "agent-sdk";
  const isLocal = isProviderLocal(item.id);
  const showConfiguredCommand = isCommandBased
    && currentCommandKind === item.kind
    && currentCommand;
  const rawLabel = isCommandBased
    ? showConfiguredCommand
      ? `${item.kind}: ${currentCommand}`
      : "+ Add custom..."
    : item.displayName;
  const labelColor = dimmed ? t.textDim : isCursor ? t.accent : t.text;
  const showCheck = isSelected && !dimmed;
  const statusLabel = dimmed
    ? isLocal
      ? "(no models)"
      : "(unavailable)"
    : null;
  const { label, suffix, checkmark } = formatPickerLine(
    rawLabel,
    isCommandBased ? null : item.badge,
    isCommandBased ? null : (item.version ?? null),
    statusLabel,
    showCheck,
    maxWidth,
  );
  const gap = padBetween(label, suffix, maxWidth - CHECKMARK_WIDTH);
  return (
    <Text>
      <Text color={labelColor} bold={isCursor && !dimmed}>
        {label}
      </Text>
      <Text color={t.textDim}>{gap}{suffix.trimStart()}</Text>
      {checkmark ? <Text color={t.success}> {"\u2713"}</Text> : <Text>{"  "}</Text>}
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

export function renderModelRow({
  item,
  isCursor,
  maxWidth,
  currentModel,
  theme: t,
}: ModelRowParams) {
  const isCfgMatch = item.id === currentModel;
  const modelName = formatModelName(item.id);
  const isAutoModel = item.isDefault && item.id === 'auto';

  const contextStr = !isAutoModel && item.contextLength ? formatContextLength(item.contextLength) : '';
  const metaSuffix = contextStr ? ` ${contextStr}` : '';

  const badge = isCustomModel(item) ? "(custom)" : isAutoModel ? "(auto)" : null;

  const { label, suffix, checkmark } = formatPickerLine(
    modelName,
    badge,
    null,
    null,
    isCfgMatch,
    maxWidth - metaSuffix.length,
  );

  const rightPart = (suffix + metaSuffix).trimStart();
  const gap = padBetween(label, rightPart, maxWidth - CHECKMARK_WIDTH);

  return (
    <Text>
      <Text color={isCursor ? t.accent : t.text} bold={isCursor}>
        {label}
      </Text>
      <Text color={t.textDim}>
        {gap}{rightPart}
      </Text>
      {checkmark ? <Text color={t.success}> {"\u2713"}</Text> : <Text>{"  "}</Text>}
    </Text>
  );
}
