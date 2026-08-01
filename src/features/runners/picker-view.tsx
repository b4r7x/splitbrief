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
import type { PickerOption } from './model-catalog/options.js';
import { isCustomModel, type ModelOption } from './model-catalog/recency.js';
import { buildRightModels } from './model-catalog/catalog.js';
import { modelCacheStore } from '../../stores/discovery/model-cache.js';
import {
  formatModelCatalogGuidance,
  formatToolPostureSummary,
  formatToolPreview,
  isPickerItemDisabled,
} from './picker-format.js';
import { renderToolRow, renderModelRow } from './tool-row.js';
import type { PickerCatalog } from './use-picker-catalog.js';
import type { PickerActions } from './use-picker-actions.js';
import { formatModelName } from '../../core/model-display.js';
import { formatContextLength } from '../../core/formatting.js';
import { toErrorMessage } from '../../utils/format-errors.js';

function modelPreview(model: ModelOption, tool: PickerOption | undefined): string {
  const parts = [formatModelName(model.id)];
  const ctx = formatContextLength(model.contextLength);
  if (ctx) parts.push(`${ctx} context`);
  if (tool) parts.push(`via ${tool.displayName}`);
  return parts.join(SOFT_SEP);
}

function modelGuidancePreview(item: PickerOption, modelCount: number): string {
  const guidance = formatModelCatalogGuidance(item, modelCount);
  const parts = [guidance.headline];
  if (guidance.detail) parts.push(guidance.detail);
  parts.push(formatToolPostureSummary(item));
  return parts.filter(Boolean).join(SOFT_SEP);
}

function ModelGuidance({
  currentItem,
  modelCount,
}: {
  currentItem: PickerOption | undefined;
  modelCount: number;
}) {
  const t = useTheme();
  if (!currentItem) {
    return <Text color={t.textDim}>Select a tool</Text>;
  }

  const guidance = formatModelCatalogGuidance(currentItem, modelCount);
  const posture = formatToolPostureSummary(currentItem);

  return (
    <Box flexDirection="column">
      <Text color={t.textDim}>{guidance.headline}</Text>
      {guidance.detail ? (
        <Text color={t.textDim} dimColor>
          {guidance.detail}
        </Text>
      ) : null}
      {posture ? (
        <Text color={t.textDim} dimColor>
          {posture}
        </Text>
      ) : null}
    </Box>
  );
}

interface PickerViewProps {
  role: 'planner' | 'implementer';
  stepLabel?: string | undefined;
  onCancel?: (() => void) | undefined;
  catalog: PickerCatalog;
  actions: PickerActions;
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
  const allowsCustom = catalog.currentItem?.modelCapability.allowsCustom ?? false;

  // Both the mount index and every reset must land on the configured model, or
  // confirming without first moving within the model column silently rewrites it.
  const resolveModelIndex = (item: PickerOption | undefined): number | undefined => {
    if (!item?.isCurrent) return undefined;
    const models = buildRightModels({
      isPlanner: role === 'planner',
      customModels: catalog.customModels,
      currentItem: item,
      cache: modelCacheStore,
    });
    const idx = models.findIndex((model) => model.id === catalog.persistedModel);
    if (idx < 0) return undefined;
    return idx + (item.modelCapability.allowsCustom ? 1 : 0);
  };
  const initialRightIndex = resolveModelIndex(catalog.currentItem);

  const handleRefresh = () => {
    void refreshPickerDetection(projectDir);
  };

  const resolvePreview = (ctx: PreviewContext<PickerOption, ModelOption>): string | undefined => {
    if (ctx.isOnLeftCustomItem) return undefined;
    if (ctx.isOnCustomItem) {
      const tool = catalog.currentItem;
      const toolName = tool?.displayName ?? role;
      const parts = [`add a model id ${toolName} can't auto-detect`];
      if (tool) parts.push(modelGuidancePreview(tool, catalog.discoveredModelCount));
      return parts.join(SOFT_SEP);
    }
    if (ctx.activeColumn === 'right' && ctx.rightItem) {
      return modelPreview(ctx.rightItem, catalog.currentItem);
    }
    const tool = ctx.leftItem ?? catalog.currentItem;
    if (!tool) return undefined;
    if (ctx.activeColumn === 'right' && catalog.rightModels.length === 0) {
      return modelGuidancePreview(tool, 0);
    }
    return formatToolPreview(tool, catalog.discoveredModelCount);
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
        isDisabled: isPickerItemDisabled,
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
        resolveInitialIndex: resolveModelIndex,
        onLeftChange: actions.leftChange,
        placeholder: (
          <ModelGuidance
            currentItem={catalog.currentItem}
            modelCount={catalog.discoveredModelCount}
          />
        ),
        ...(allowsCustom
          ? {
              customRow: {
                onSelect: actions.openCustomModel,
                onDelete: actions.deleteRight,
                isCustom: isCustomModel,
              },
            }
          : {}),
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
