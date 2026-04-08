import { useReducer } from 'react';
import { Box } from 'ink';
import { Text } from 'ink';
import type { Config } from '../../../types.js';
import { Spinner } from '../../../ui/spinner.js';
import { useTheme } from '../../../ui/theme.js';
import { useResponsiveLayout } from '../../../hooks/use-terminal-size.js';
import { TextInputOverlay } from '../text-input-overlay.js';
import { usePickerCatalog } from './use-picker-catalog.js';
import { usePickerActions } from './use-picker-actions.js';
import { PickerView } from './picker-view.js';
import type { PickerOption } from './picker-catalog.js';

export type View =
  | { kind: 'picker' }
  | { kind: 'custom-command' }
  | { kind: 'custom-model'; item: PickerOption };

export type ViewAction =
  | { type: 'open-custom-command'; preservedLeftIndex: number }
  | { type: 'open-custom-model'; item: PickerOption }
  | { type: 'close' };

export interface ViewState {
  view: View;
  preservedLeftIndex: number;
}

const initialViewState: ViewState = {
  view: { kind: 'picker' },
  preservedLeftIndex: 0,
};

function viewReducer(state: ViewState, action: ViewAction): ViewState {
  switch (action.type) {
    case 'open-custom-command':
      return { view: { kind: 'custom-command' }, preservedLeftIndex: action.preservedLeftIndex };
    case 'open-custom-model':
      return { ...state, view: { kind: 'custom-model', item: action.item } };
    case 'close':
      return { ...state, view: { kind: 'picker' } };
  }
}

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
  const { cols, rows } = useResponsiveLayout();

  if (!catalog.ready) {
    return (
      <Box width={cols} height={rows} alignItems="center" justifyContent="center">
        <Spinner label={role === 'planner' ? 'Detecting planners...' : 'Detecting providers...'} color={t.accent} />
      </Box>
    );
  }

  if (viewState.view.kind === 'custom-command') {
    return (
      <TextInputOverlay
        title={`Custom ${catalog.roleLabel} Command`}
        label="Command to run:"
        placeholder="e.g. my-ai-tool --format stream-json"
        initialValue={catalog.currentCommand ?? ''}
        rows={1}
        maxRows={3}
        onCancel={actions.closeOverlay}
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
        onCancel={actions.closeOverlay}
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
