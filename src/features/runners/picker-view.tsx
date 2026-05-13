import { Box, Text } from 'ink';
import { TwoColumnPicker } from '../../components/pickers/two-column-picker/picker.js';
import { useTheme } from '../../components/theme.js';
import { overlayStore } from '../../stores/ui/overlay.js';
import { refreshDetectionStores } from '../../stores/discovery/detection-adapter.js';
import { getDefaultDetectionService } from '../../engine/detection/service.js';
import { configStore } from '../../stores/project/config.js';
import { feedbackStore } from '../../stores/ui/feedback.js';
import type { PickerOption, ModelOption } from './model-catalog.js';
import { isCustomModel } from './model-catalog.js';
import { renderToolRow, renderModelRow } from './tool-row.js';
import type { PickerCatalog } from './use-picker-catalog.js';
import type { PickerActions } from './use-picker-actions.js';
import { PROVIDER_CATALOG } from '../../core/providers/catalog.js';
import { isProviderId } from '../../core/schemas/enums.js';
import { toErrorMessage } from '../../utils/format-errors.js';

const CUSTOM_ROW_OFFSET = 1;

interface PickerViewProps {
  role: 'planner' | 'implementer';
  stepLabel?: string | undefined;
  onCancel?: (() => void) | undefined;
  catalog: PickerCatalog;
  actions: PickerActions;
}

function ProviderHint({ currentItem }: { currentItem: PickerOption | undefined }) {
  const t = useTheme();
  if (!currentItem) return <Text color={t.textDim}>No models available.</Text>;

  const isOllama = currentItem.id === 'ollama';
  const isLmStudio = currentItem.id === 'lm-studio';

  if (isOllama) {
    return (
      <Box flexDirection="column">
        <Text color={t.textDim}>No models pulled.</Text>
        <Text color={t.textDim} dimColor>Run: ollama pull qwen2.5-coder:7b</Text>
      </Box>
    );
  }

  if (isLmStudio) {
    return (
      <Box flexDirection="column">
        <Text color={t.textDim}>No models loaded.</Text>
        <Text color={t.textDim} dimColor>Download a model in LM Studio.</Text>
      </Box>
    );
  }

  if (currentItem.kind === 'api' && !currentItem.available && isProviderId(currentItem.id)) {
    const catalog = PROVIDER_CATALOG[currentItem.id];
    const envVar = catalog?.apiKeyEnv;
    if (envVar) {
      return (
        <Box flexDirection="column">
          <Text color={t.textDim}>Provider not configured.</Text>
          <Text color={t.textDim} dimColor>Set {envVar} to enable.</Text>
        </Box>
      );
    }
  }

  return <Text color={t.textDim}>No models available. Press Ctrl+R to refresh.</Text>;
}

const defaultRefresh = (projectDir: string | undefined) => refreshDetectionStores(getDefaultDetectionService(), projectDir);

export async function refreshPickerDetection(
  projectDir: string,
  refresh: (projectDir: string | undefined) => Promise<void> = defaultRefresh,
): Promise<void> {
  feedbackStore.setMessage('Refreshing models...');
  try {
    await refresh(projectDir);
    feedbackStore.setMessage('Models refreshed');
  } catch (err) {
    feedbackStore.setError(`Failed to refresh models: ${toErrorMessage(err)}`);
  }
}

export function PickerView({ role, stepLabel, onCancel, catalog, actions }: PickerViewProps) {
  const t = useTheme();
  const projectDir = configStore.use(s => s.projectDir);

  const currentModelIdx = catalog.focusModels
    ? catalog.rightModels.findIndex(m => m.id === catalog.currentModel)
    : -1;
  const initialRightIndex = currentModelIdx >= 0 ? currentModelIdx + CUSTOM_ROW_OFFSET : undefined;

  const handleRefresh = () => {
    void refreshPickerDetection(projectDir);
  };

  return (
    <TwoColumnPicker<PickerOption, ModelOption>
      title={catalog.roleLabel}
      stepLabel={stepLabel}
      initialColumn={catalog.focusModels ? 'right' : 'left'}
      onConfirm={actions.confirm}
      onCancel={onCancel ?? (() => overlayStore.close())}
      onRefresh={handleRefresh}
      leftProps={{
        items: catalog.items,
        label: 'Tools',
        getKey: item => item.id,
        isSpecial: item => item.kind === 'shell' || item.kind === 'agent',
        isDisabled: item => !item.available && item.kind !== 'shell' && item.kind !== 'agent',
        initialIndex: catalog.initialLeftIdx,
        specialHelp: (
          <Box flexDirection="column" marginTop={1} paddingX={1}>
            <Text color={t.textDim}>Run a custom command as the {role}.</Text>
            <Text color={t.textDim}>Press Enter to configure the command.</Text>
          </Box>
        ),
        renderRow: (item, { isCursor, isSelected, maxWidth }) =>
          renderToolRow({
            item, isCursor, isSelected, maxWidth,
            currentCommand: catalog.currentCommand,
            currentCommandKind: catalog.currentCommandKind,
            theme: t,
          }),
      }}
      rightProps={{
        items: catalog.rightModels,
        label: 'Models',
        getKey: item => item.id,
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
            item, isCursor, maxWidth, currentModel: catalog.currentModel, theme: t,
          }),
      }}
    />
  );
}
