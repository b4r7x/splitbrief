import { Box, Text } from 'ink';
import { TwoColumnPicker } from '../../pickers/two-column-picker/index.js';
import { useTheme } from '../../../ui/theme.js';
import { overlayStore } from '../../../stores/overlay.js';
import { modelCacheStore } from '../../../stores/model-cache.js';
import { detectionStore } from '../../../stores/detection.js';
import { configStore } from '../../../stores/config.js';
import { feedbackStore } from '../../../stores/feedback.js';
import type { PickerOption, ModelOption } from './picker-catalog.js';
import { isCustomModel } from './picker-catalog.js';
import { renderToolRow, renderModelRow } from './tool-row.js';
import type { PickerCatalog } from './use-picker-catalog.js';
import type { PickerActions } from './use-picker-actions.js';
import { PROVIDER_CATALOG, isProviderId } from '../../../core/providers.js';

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

export function PickerView({ role, stepLabel, onCancel, catalog, actions }: PickerViewProps) {
  const t = useTheme();
  const isPlanner = role === 'planner';

  const currentModelIdx = catalog.focusModels
    ? catalog.rightModels.findIndex(m => m.id === catalog.currentModel)
    : -1;
  // +1 offset accounts for virtual custom row prepended by allowCustomRight
  const initialRightIndex = currentModelIdx >= 0 ? currentModelIdx + 1 : undefined;

  const handleRefresh = () => {
    modelCacheStore.invalidateAll();
    const projectDir = configStore.get().projectDir;
    if (projectDir) {
      detectionStore.invalidate(projectDir).then(() => detectionStore.load(projectDir));
    }
    feedbackStore.setMessage('Refreshing models...');
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
        isDisabled: item => !item.available && item.kind !== 'shell' && item.kind !== 'agent' && item.kind !== 'agent-sdk',
        initialIndex: catalog.initialLeftIdx,
        specialHelp: (
          <Box flexDirection="column" marginTop={1} paddingX={1}>
            <Text color={t.textDim}>Run a custom shell command as the {role}.</Text>
            <Text color={t.textDim}>Press Enter to configure the command.</Text>
          </Box>
        ),
        renderRow: (item, { isCursor, isSelected, maxWidth }) =>
          renderToolRow({
            item, isCursor, isSelected, maxWidth, isPlanner,
            currentCommand: catalog.currentCommand,
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
          renderModelRow({ item, isCursor, maxWidth, currentModel: catalog.currentModel, theme: t }),
      }}
    />
  );
}
