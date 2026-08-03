import { useReducer } from 'react';
import { useInput } from 'ink';
import type { Config } from '../../core/schemas/config.js';
import { ARROW_SEP, SOFT_SEP } from '../../components/separators.js';
import { overlayStore } from '../../stores/ui/overlay.js';
import { usePickerCatalog } from '../../features/runners/use-picker-catalog.js';
import { usePickerActions } from '../../features/runners/use-picker-actions.js';
import { viewReducer, initialViewState } from '../../features/runners/view-state.js';
import { PickerView } from '../../features/runners/picker-view.js';
import { TextInputOverlay } from '../../features/runners/text-input-overlay.js';
import { ContractChoiceOverlay } from '../../features/runners/contract-choice-overlay.js';
import { ProviderAuthOverlay } from '../../features/runners/provider-auth-overlay.js';
import { ProviderChoiceOverlay } from '../../features/runners/provider-choice-overlay.js';
import { ContractRecap, StepIndicator, contractTierOf } from '../../features/runners/sub-panel.js';

interface ToolModelPickerProps {
  role: 'planner' | 'implementer';
  stepLabel?: string | undefined;
  onConfirm?: ((updated: Config) => void) | undefined;
  onCancel?: (() => void) | undefined;
}

export function ToolModelPicker({ role, stepLabel, onConfirm, onCancel }: ToolModelPickerProps) {
  const [viewState, dispatchView] = useReducer(viewReducer, initialViewState);
  const catalog = usePickerCatalog(role, viewState.preservedLeftIndex);
  const actions = usePickerActions({ role, onConfirm, catalog, viewState, dispatchView });
  const isSubView = viewState.view.kind !== 'picker';
  const overlayAllowsKeys = overlayStore.use(
    (s) =>
      s.active === 'none' || s.active === 'planner-picker' || s.active === 'implementer-picker',
  );

  useInput(
    (_input, key) => {
      if (!key.escape) return;
      if (viewState.view.kind === 'custom-command') {
        dispatchView({ type: 'back-to-contract' });
        return;
      }
      actions.closeOverlay();
    },
    { isActive: isSubView && overlayAllowsKeys },
  );

  if (viewState.view.kind === 'custom-command-contract') {
    return (
      <ContractChoiceOverlay
        role={role}
        initialKind={viewState.view.refocusKind ?? catalog.currentCommandKind}
        configuredKind={catalog.currentCommandKind}
        onChoose={actions.chooseContract}
      />
    );
  }

  if (viewState.view.kind === 'custom-command') {
    const tier = contractTierOf(viewState.view.intendedKind);
    return (
      <TextInputOverlay
        title="Custom command"
        role={role}
        stepIndicator={<StepIndicator active="command" />}
        recap={<ContractRecap tier={tier} />}
        label="Command to run"
        placeholder="e.g. my-ai-tool --format stream-json"
        initialValue={viewState.view.draft ?? catalog.currentCommand ?? ''}
        helper={
          tier === 'output'
            ? `prompt on stdin${ARROW_SEP}result on stdout`
            : `writes into the working tree${SOFT_SEP}no stdout extraction`
        }
        examples={[tier === 'output' ? 'my-planner --json' : 'aider --message-file BRIEF.md']}
        hint={`⏎ save${SOFT_SEP}esc back to contract`}
        rows={1}
        maxRows={3}
        onChange={(draft) => dispatchView({ type: 'set-custom-command-draft', draft })}
        onSubmit={actions.customCommand}
      />
    );
  }

  if (viewState.view.kind === 'provider-auth') {
    return (
      <ProviderAuthOverlay
        role={role}
        item={viewState.view.item}
        onSubmit={(value) => void actions.submitProviderKey(value)}
      />
    );
  }

  if (viewState.view.kind === 'provider-choice') {
    return (
      <ProviderChoiceOverlay
        role={role}
        item={viewState.view.item}
        model={viewState.view.model}
        onChoose={(fullId) => void actions.confirmProviderVariant(fullId)}
      />
    );
  }

  if (viewState.view.kind === 'custom-model') {
    const item = viewState.view.item;
    return (
      <TextInputOverlay
        title="Custom model"
        role={role}
        label={`Model id for ${item.displayName}`}
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
