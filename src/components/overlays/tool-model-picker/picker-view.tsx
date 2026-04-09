import { Box, Text } from 'ink';
import { TwoColumnPicker } from '../../pickers/two-column-picker/index.js';
import { useTheme } from '../../../ui/theme.js';
import { overlayStore } from '../../../stores/overlay.js';
import type { PickerOption, ModelOption } from './picker-catalog.js';
import { isCustomModel } from './picker-catalog.js';
import { renderToolRow, renderModelRow } from './tool-row.js';
import type { PickerCatalog } from './use-picker-catalog.js';
import type { PickerActions } from './use-picker-actions.js';

interface PickerViewProps {
  role: 'planner' | 'implementer';
  stepLabel?: string | undefined;
  onCancel?: (() => void) | undefined;
  catalog: PickerCatalog;
  actions: PickerActions;
}

function ProviderHint({ currentItem }: { currentItem: PickerOption | undefined }) {
  const t = useTheme();
  const isOllama = currentItem?.id === 'ollama';
  const isLmStudio = currentItem?.id === 'lm-studio';

  if (isOllama) {
    return (
      <Box flexDirection="column">
        <Text color={t.textDim}>No models detected.</Text>
        <Text color={t.textDim} dimColor>Start Ollama to see models:</Text>
        <Text color={t.textDim} dimColor>  ollama serve</Text>
      </Box>
    );
  }

  if (isLmStudio) {
    return (
      <Box flexDirection="column">
        <Text color={t.textDim}>No models detected.</Text>
        <Text color={t.textDim} dimColor>Start LM Studio and enable the server.</Text>
      </Box>
    );
  }

  return <Text color={t.textDim}>No models available.</Text>;
}

export function PickerView({ role, stepLabel, onCancel, catalog, actions }: PickerViewProps) {
  const t = useTheme();
  const isPlanner = role === 'planner';

  const currentModelIdx = catalog.focusModels
    ? catalog.rightModels.findIndex(m => m.id === catalog.currentModel)
    : -1;
  // +1 offset accounts for virtual custom row prepended by allowCustomRight
  const initialRightIndex = currentModelIdx >= 0 ? currentModelIdx + 1 : undefined;

  return (
    <TwoColumnPicker<PickerOption, ModelOption>
      title={catalog.roleLabel}
      stepLabel={stepLabel}
      initialColumn={catalog.focusModels ? 'right' : 'left'}
      onConfirm={actions.confirm}
      onCancel={onCancel ?? (() => overlayStore.close())}
      leftProps={{
        items: catalog.items,
        label: 'Tools',
        getKey: item => item.id,
        isSpecial: item => item.kind === 'shell',
        isDisabled: item => !item.available && item.kind !== 'shell',
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
