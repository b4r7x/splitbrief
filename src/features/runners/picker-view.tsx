import { Box, Text } from 'ink';
import { TwoColumnPicker, type PreviewContext } from './two-column-picker/picker.js';
import { SOFT_SEP } from '../../components/separators.js';
import { useTheme } from '../../components/theme.js';
import { overlayStore } from '../../stores/ui/overlay.js';
import { refreshDetectionStores } from '../../stores/discovery/detection-adapter.js';
import { detectionStore } from '../../stores/project/detection.js';
import { getDefaultDetectionService } from '../../engine/detection/service.js';
import { configStore } from '../../stores/project/config.js';
import { feedbackStore } from '../../stores/ui/feedback.js';
import type { PickerOption, ModelOption } from './model-catalog.js';
import { isCustomModel } from './model-catalog.js';
import { renderToolRow, renderModelRow } from './tool-row.js';
import type { PickerCatalog } from './use-picker-catalog.js';
import type { PickerActions } from './use-picker-actions.js';
import { PROVIDER_CATALOG, isProviderLocal } from '../../core/providers/catalog.js';
import { isProviderId } from '../../core/schemas/enums.js';
import { formatModelName } from '../../core/model-display.js';
import { formatContextLength } from '../../core/formatting.js';
import { toErrorMessage } from '../../utils/format-errors.js';

const CUSTOM_ROW_OFFSET = 1;

function toolPreview(item: PickerOption, modelCount: number): string {
  const name = item.displayName;
  const isCommandBased = item.kind === 'shell' || item.kind === 'agent';
  if (!item.available && !isCommandBased && item.kind !== 'agent-sdk') {
    return [name, item.kind, isProviderLocal(item.id) ? 'no models' : 'unavailable'].join(SOFT_SEP);
  }
  const noun = modelCount === 1 ? 'model' : 'models';
  return [name, item.kind, `${modelCount} ${noun} detected`].join(SOFT_SEP);
}

function modelPreview(model: ModelOption, tool: PickerOption | undefined): string {
  const parts = [formatModelName(model.id)];
  const ctx = formatContextLength(model.contextLength);
  if (ctx) parts.push(`${ctx} context`);
  if (tool) parts.push(`via ${tool.displayName}`);
  return parts.join(SOFT_SEP);
}

interface PickerViewProps {
  role: 'planner' | 'implementer';
  stepLabel?: string | undefined;
  onCancel?: (() => void) | undefined;
  catalog: PickerCatalog;
  actions: PickerActions;
}

function ProviderHint({ currentItem }: { currentItem: PickerOption | undefined }) {
  const t = useTheme();
  if (!currentItem) return <Text color={t.textDim}>No models available</Text>;

  const isOllama = currentItem.id === 'ollama';
  const isLmStudio = currentItem.id === 'lm-studio';

  if (isOllama) {
    return (
      <Box flexDirection="column">
        <Text color={t.textDim}>No models pulled</Text>
        <Text color={t.textDim} dimColor>
          Run: ollama pull qwen3-coder:30b
        </Text>
      </Box>
    );
  }

  if (isLmStudio) {
    return (
      <Box flexDirection="column">
        <Text color={t.textDim}>No models loaded</Text>
        <Text color={t.textDim} dimColor>
          Download a model in LM Studio
        </Text>
      </Box>
    );
  }

  if (currentItem.kind === 'api' && !currentItem.available && isProviderId(currentItem.id)) {
    const catalog = PROVIDER_CATALOG[currentItem.id];
    const envVar = catalog?.apiKeyEnv;
    if (envVar) {
      return (
        <Box flexDirection="column">
          <Text color={t.textDim}>Provider not configured</Text>
          <Text color={t.textDim} dimColor>
            Set {envVar} to enable
          </Text>
        </Box>
      );
    }
  }

  return (
    <Box flexDirection="column">
      <Text color={t.textDim}>No models available</Text>
      <Text color={t.textDim} dimColor>
        Press ctrl+r to refresh
      </Text>
    </Box>
  );
}

const defaultRefresh = (projectDir: string | undefined) =>
  refreshDetectionStores(getDefaultDetectionService(), detectionStore, projectDir);

export async function refreshPickerDetection(
  projectDir: string,
  refresh: (projectDir: string | undefined) => Promise<void> = defaultRefresh,
): Promise<void> {
  feedbackStore.setMessage('Refreshing models…');
  try {
    await refresh(projectDir);
    feedbackStore.setMessage('Models refreshed');
  } catch (err) {
    feedbackStore.setError(`Failed to refresh models: ${toErrorMessage(err)}`);
  }
}

export function PickerView({ role, stepLabel, onCancel, catalog, actions }: PickerViewProps) {
  const t = useTheme();
  const projectDir = configStore.use((s) => s.projectDir);
  const roleTitle = role === 'planner' ? 'Planner' : 'Implementer';

  const currentModelIdx = catalog.focusModels
    ? catalog.rightModels.findIndex((m) => m.id === catalog.currentModel)
    : -1;
  const initialRightIndex = currentModelIdx >= 0 ? currentModelIdx + CUSTOM_ROW_OFFSET : undefined;

  const handleRefresh = () => {
    void refreshPickerDetection(projectDir);
  };

  const resolvePreview = (ctx: PreviewContext<PickerOption, ModelOption>): string | undefined => {
    if (ctx.isOnLeftCustomItem) return undefined;
    if (ctx.isOnCustomItem) {
      const toolName = catalog.currentItem?.displayName ?? role;
      return `add a model id ${toolName} can't auto-detect`;
    }
    if (ctx.activeColumn === 'right' && ctx.rightItem) {
      return modelPreview(ctx.rightItem, catalog.currentItem);
    }
    const tool = ctx.leftItem ?? catalog.currentItem;
    return tool ? toolPreview(tool, catalog.rightModels.length) : undefined;
  };

  return (
    <TwoColumnPicker<PickerOption, ModelOption>
      title={roleTitle}
      subtitle={role === 'planner' ? 'Tool & model' : 'Model'}
      stepLabel={stepLabel}
      initialColumn={catalog.focusModels ? 'right' : 'left'}
      onConfirm={actions.confirm}
      onCancel={onCancel ?? (() => overlayStore.close())}
      onRefresh={handleRefresh}
      preview={resolvePreview}
      leftProps={{
        items: catalog.items,
        label: 'Tools',
        getKey: (item) => item.id,
        isSpecial: (item) => item.kind === 'shell' || item.kind === 'agent',
        isDisabled: (item) => !item.available && item.kind !== 'shell' && item.kind !== 'agent',
        initialIndex: catalog.initialLeftIdx,
        specialHelp: (
          <Box flexDirection="column">
            <Text color={t.textDim}>run a custom command as the {role}.</Text>
            <Text color={t.textDim}>press ⏎ to configure the command.</Text>
          </Box>
        ),
        renderRow: (item, { isCursor, isSelected, maxWidth }) =>
          renderToolRow({
            item,
            isCursor,
            isSelected,
            maxWidth,
            currentCommand: catalog.currentCommand,
            currentCommandKind: catalog.currentCommandKind,
          }),
      }}
      rightProps={{
        items: catalog.rightModels,
        label: 'Models',
        getKey: (item) => item.id,
        initialIndex: initialRightIndex,
        onLeftChange: actions.leftChange,
        placeholder: <ProviderHint currentItem={catalog.currentItem} />,
        customRow: {
          onSelect: actions.openCustomModel,
          onDelete: actions.deleteRight,
          isCustom: isCustomModel,
        },
        renderRow: (item, { isCursor, maxWidth }) =>
          renderModelRow({
            item,
            isCursor,
            maxWidth,
            currentModel: catalog.currentModel,
          }),
      }}
    />
  );
}
