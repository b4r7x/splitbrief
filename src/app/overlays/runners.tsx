import { useEffect } from 'react';
import { useInput } from 'ink';
import { seatPickerLane, type SeatPickerRole } from '../../core/runners/seat-roles.js';
import { OverlayPanel } from '../../components/overlays/overlay-panel.js';
import { arrowSep, SOFT_SEP } from '../../components/separators.js';
import { BOOT_MANIFEST_TITLE } from '../../core/discovery/copy.js';
import { BootManifest } from '../../features/runners/boot-manifest.js';
import { overlayStore } from '../../stores/ui/overlay.js';
import { pickerViewStore } from '../../stores/ui/picker-view.js';
import { usePickerCatalog } from '../../features/runners/use-picker-catalog.js';
import { usePickerActions } from '../../features/runners/use-picker-actions.js';
import { PickerView } from '../../features/runners/picker-view.js';
import { TextInputOverlay } from '../../features/runners/text-input-overlay.js';
import { ContractChoiceOverlay } from '../../features/runners/contract-choice-overlay.js';
import { ContractRecap, StepIndicator } from '../../features/runners/contract-chip.js';
import { contractForRunnerKind } from '../../core/config/custom-commands.js';
import { overlayAllowsPickerKeys } from '../../core/navigation/types.js';

interface ToolModelPickerProps {
  role: SeatPickerRole;
}

export function ToolModelPicker({ role }: ToolModelPickerProps) {
  const lane = seatPickerLane(role);
  const view = pickerViewStore.use((s) => s.view);
  const preservedLeftIndex = pickerViewStore.use((s) => s.preservedLeftIndex);
  const draft = pickerViewStore.use((s) => s.draft);
  const catalog = usePickerCatalog(role, preservedLeftIndex);
  const actions = usePickerActions({ role, catalog });
  const isSubView = view.kind !== 'picker';
  const overlayAllowsKeys = overlayStore.use((s) => overlayAllowsPickerKeys(s.active));
  const coldDiscovery = catalog.discovery.cold && catalog.discovery.refreshing;
  const item = catalog.currentItem;

  useEffect(() => () => pickerViewStore.reset(), []);

  useInput(
    (_input, key) => {
      if (!key.escape) return;
      if (coldDiscovery) {
        overlayStore.close();
        return;
      }
      if (view.kind === 'custom-command') {
        pickerViewStore.open({ kind: 'custom-command-contract', refocusKind: view.intendedKind });
        return;
      }
      actions.closeOverlay();
    },
    { isActive: (isSubView || coldDiscovery) && overlayAllowsKeys },
  );

  if (coldDiscovery) {
    return (
      <OverlayPanel title={BOOT_MANIFEST_TITLE} density="compact" hint="esc close">
        <BootManifest />
      </OverlayPanel>
    );
  }

  if (view.kind === 'custom-command-contract') {
    return (
      <ContractChoiceOverlay
        role={lane}
        initialKind={view.refocusKind ?? catalog.currentCommandKind}
        configuredKind={catalog.currentCommandKind}
        onChoose={actions.chooseContract}
      />
    );
  }

  if (view.kind === 'custom-command') {
    const tier = contractForRunnerKind(view.intendedKind);
    return (
      <TextInputOverlay
        title="Custom command"
        role={role}
        stepIndicator={<StepIndicator active="command" />}
        recap={<ContractRecap tier={tier} />}
        label="Command to run"
        placeholder="e.g. my-ai-tool --format stream-json"
        initialValue={draft ?? catalog.currentCommand ?? ''}
        helper={
          tier === 'output'
            ? `prompt on stdin${arrowSep()}result on stdout`
            : `writes into the working tree${SOFT_SEP}no stdout extraction`
        }
        examples={[tier === 'output' ? 'my-planner --json' : 'opencode run --agent build']}
        hint={`⏎ save${SOFT_SEP}esc back to contract`}
        rows={1}
        maxRows={3}
        onChange={pickerViewStore.setDraft}
        onSubmit={actions.customCommand}
      />
    );
  }

  if (view.kind === 'custom-model' && item !== undefined) {
    return (
      <TextInputOverlay
        title="Custom model"
        role={role}
        label={`Model id for ${item.displayName}`}
        placeholder="e.g. my-org/custom-model or llama3.3:latest"
        examples={['llama3.3:70b-instruct-q4_K_M', 'qwen3-coder:30b', 'openai/gpt-5.6-sol']}
        onSubmit={actions.customModel}
      />
    );
  }

  return <PickerView role={role} catalog={catalog} actions={actions} />;
}
