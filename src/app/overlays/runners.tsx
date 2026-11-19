import { useEffect } from 'react';
import { useInput } from 'ink';
import {
  seatPickerLane,
  type PickerSlot,
  type SeatPickerRole,
} from '../../core/runners/seat-roles.js';
import { OverlayPanel } from '../../components/overlays/panel.js';
import { ThemeText as Text, useTheme } from '../../components/theme.js';
import { arrowSep, SOFT_SEP } from '../../core/separators.js';
import { CLOSE_HINT, formatKeyHints } from '../../components/key-legend.js';
import { BOOT_MANIFEST_TITLE } from '../../core/discovery/copy.js';
import { BootManifest } from '../../features/runners/boot-manifest.js';
import { overlayStore } from '../../stores/ui/overlay.js';
import { pickerViewStore } from '../../stores/ui/picker-view.js';
import { usePickerCatalog } from '../../features/runners/picker/use-catalog.js';
import {
  defaultPickerEffectDeps,
  usePickerActions,
  type PickerEffectDeps,
} from '../../features/runners/picker/use-actions.js';
import { useLocalConnectionActions } from '../../features/runners/picker/use-local-connection-actions.js';
import { PickerView } from '../../features/runners/picker/view.js';
import { customModelEntryCopy } from '../../features/runners/picker/listing-source.js';
import { fallbackInheritanceNotice } from '../../features/runners/picker/labels.js';
import { inheritsPlannerSeat } from '../../features/runners/config-transforms/seat-selection.js';
import { LocalConnectionForm } from '../../features/runners/local-connection/form.js';
import { TextInputOverlay } from '../../features/runners/text-input-overlay.js';
import { ContractChoiceOverlay } from '../../features/runners/contract/choice-overlay.js';
import { ContractRecap, StepIndicator } from '../../features/runners/contract/chip.js';
import { contractForRunnerKind } from '../../core/config/custom-commands/tuple.js';
import { overlayAllowsPickerKeys } from '../../core/navigation/types.js';
import { configStore } from '../../stores/project/config.js';

interface ToolModelPickerProps {
  role: SeatPickerRole;
  slot: PickerSlot;
  deps?: PickerEffectDeps | undefined;
}

export function ToolModelPicker({
  role,
  slot,
  deps = defaultPickerEffectDeps,
}: ToolModelPickerProps) {
  const t = useTheme();
  const lane = seatPickerLane(role);
  const inheritedReview = configStore.use(
    (s) => s.config !== null && inheritsPlannerSeat(s.config, 'reviewer'),
  );
  const view = pickerViewStore.use((s) => s.view);
  const preservedLeftIndex = pickerViewStore.use((s) => s.preservedLeftIndex);
  const draft = pickerViewStore.use((s) => s.draft);
  const catalog = usePickerCatalog(role, slot, preservedLeftIndex);
  const actions = usePickerActions({ role, slot, catalog, deps });
  const localConnection = useLocalConnectionActions(role, deps);
  const isSubView = view.kind !== 'picker';
  const overlayAllowsKeys = overlayStore.use((s) => overlayAllowsPickerKeys(s.active));
  const focus = overlayStore.use((s) => s.focus);
  const coldDiscovery = catalog.discovery.cold && catalog.discovery.refreshing;
  const item = catalog.currentItem;

  useEffect(() => configStore.reloadShownConfig(), []);
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
      <OverlayPanel
        title={BOOT_MANIFEST_TITLE}
        density="compact"
        hint={formatKeyHints([CLOSE_HINT])}
      >
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
        hint={formatKeyHints([
          { key: '⏎', verb: 'save' },
          { key: 'esc', verb: 'back to contract' },
        ])}
        rows={1}
        maxRows={3}
        onChange={pickerViewStore.setDraft}
        onSubmit={actions.customCommand}
      />
    );
  }

  if (view.kind === 'local-connection') {
    return (
      <LocalConnectionForm
        role={role}
        provider={view.provider}
        seat={localConnection.seat(view.provider)}
        check={localConnection.check}
        onSave={(input) => void localConnection.save(input)}
      />
    );
  }

  if (view.kind === 'custom-model' && item !== undefined) {
    const entry = customModelEntryCopy({ rows: catalog.rightRows, toolId: item.id });
    const inheritanceNotice = fallbackInheritanceNotice({ slot, role, inherited: inheritedReview });
    return (
      <TextInputOverlay
        title={slot === 'fallback' ? 'Custom fallback model' : 'Custom model'}
        role={role}
        recap={
          inheritanceNotice === undefined ? undefined : (
            <Text color={t.textDim}>{inheritanceNotice}</Text>
          )
        }
        label={`Model id for ${item.displayName}`}
        placeholder={entry.placeholder}
        examples={entry.examples}
        onSubmit={actions.customModel}
      />
    );
  }

  return (
    <PickerView
      key={focus}
      role={role}
      slot={slot}
      catalog={catalog}
      actions={actions}
      deps={deps}
    />
  );
}
