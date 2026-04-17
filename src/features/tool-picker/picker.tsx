import { useReducer } from 'react';
import { Text, useInput } from 'ink';
import type { Config } from '../../types.js';
import { useTheme } from '../../components/theme.js';
import { TextInputOverlay } from '../../components/overlays/text-input-overlay.js';
import { usePickerCatalog } from './use-picker-catalog.js';
import { usePickerActions } from './use-picker-actions.js';
import { viewReducer, initialViewState } from './view-state.js';
import { PickerView } from './picker-view.js';

interface ToolModelPickerProps {
  role: 'planner' | 'implementer';
  stepLabel?: string | undefined;
  onConfirm?: ((updated: Config) => void) | undefined;
  onCancel?: (() => void) | undefined;
}

export function ToolModelPicker({ role, stepLabel, onConfirm, onCancel }: ToolModelPickerProps) {
  const [viewState, dispatchView] = useReducer(viewReducer, initialViewState);
  const catalog = usePickerCatalog(role, viewState.preservedLeftIndex);
  const actions = usePickerActions(role, onConfirm, catalog, viewState, dispatchView);
  const t = useTheme();
  const isTextInput = viewState.view.kind === 'custom-command' || viewState.view.kind === 'custom-model';

  useInput(
    (_input, key) => {
      if (key.escape) actions.closeOverlay();
    },
    { isActive: isTextInput },
  );

  if (viewState.view.kind === 'custom-command') {
    return (
      <TextInputOverlay
        title={`Custom ${catalog.roleLabel} Command`}
        label="Command to run:"
        placeholder="e.g. my-ai-tool --format stream-json"
        initialValue={catalog.currentCommand ?? ''}
        rows={1}
        maxRows={3}
        onSubmit={actions.customCommand}
      />
    );
  }

  if (viewState.view.kind === 'custom-model') {
    const item = viewState.view.item;
    return (
      <TextInputOverlay
        title={`Custom ${catalog.roleLabel} Model`}
        label={
          <>Enter a custom model ID for <Text color={t.accent}>{item.displayName}</Text>:</>
        }
        placeholder="e.g. my-org/custom-model or llama3.3:latest"
        examples={[
          'llama3.3:70b-instruct-q4_K_M',
          'anthropic/claude-3-opus-20240229',
          'deepseek/deepseek-chat',
        ]}
        onSubmit={actions.customModel}
      />
    );
  }

  return (
    <PickerView
      role={role}
      stepLabel={stepLabel}
      onCancel={onCancel}
      catalog={catalog}
      actions={actions}
    />
  );
}
