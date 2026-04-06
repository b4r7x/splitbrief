import { useReducer, useState } from 'react';
import { Box, Text } from 'ink';
import { useTheme } from '../ui/theme.js';
import { Spinner } from '../ui/spinner.js';
import { TwoColumnPicker } from './two-column-picker.js';
import { TextInputOverlay } from './text-input-overlay.js';
import { configStore } from '../stores/config.js';
import { overlayStore } from '../stores/overlay.js';
import { feedbackStore } from '../stores/error.js';
import { detectionStore } from '../stores/detection.js';
import { getProvider } from '../engine/providers/registry.js';
import { formatModelName } from '../utils/model-names.js';
import { useResponsiveLayout } from '../hooks/use-terminal-size.js';
import type { Config, PlannerTool } from '../types.js';
import {
  buildPlannerOptions,
  buildImplementerOptions,
  modelsForPlannerBackend,
  modelsForImplementerBackend,
  type BackendOption,
  type ModelOption,
} from '../engine/providers/backend-registry.js';

interface ToolModelPickerProps {
  role: 'planner' | 'implementer';
  stepLabel?: string;
  onConfirm?: (updated: Config) => void;
  onCancel?: () => void;
}

function truncateText(text: string, maxWidth: number): string {
  if (text.length <= maxWidth) return text;
  if (maxWidth <= 3) return text.slice(0, maxWidth);
  return text.slice(0, maxWidth - 1) + '\u2026';
}

// Prioritizes: label > badge > version. Omits parts that don't fit.
function formatBackendLine(
  label: string,
  badge: string | null,
  version: string | null,
  status: string | null,
  checkmark: boolean,
  maxWidth: number,
): { label: string; suffix: string } {
  // Build suffix parts (badge, version, status, checkmark)
  const suffixParts: string[] = [];
  if (badge) suffixParts.push(`  ${badge}`);
  if (version) suffixParts.push(` v${version}`);
  if (status) suffixParts.push(` ${status}`);
  if (checkmark) suffixParts.push(' \u2713');

  const fullSuffix = suffixParts.join('');
  const availableForLabel = maxWidth - fullSuffix.length;

  // If label fits with full suffix, use as-is
  if (label.length <= availableForLabel) {
    return { label, suffix: fullSuffix };
  }

  // Try without version
  const suffixNoVersion = suffixParts.filter(p => !p.startsWith(' v')).join('');
  const availableNoVersion = maxWidth - suffixNoVersion.length;
  if (label.length <= availableNoVersion) {
    return { label, suffix: suffixNoVersion };
  }

  // Truncate label, keep essential suffix (status + checkmark)
  const essentialSuffix = (status ? ` ${status}` : '') + (checkmark ? ' \u2713' : '');
  const availableForTruncatedLabel = maxWidth - essentialSuffix.length;
  return {
    label: truncateText(label, availableForTruncatedLabel),
    suffix: essentialSuffix,
  };
}

type View =
  | { kind: 'picker' }
  | { kind: 'custom-command' }
  | { kind: 'custom-model'; backend: BackendOption };

type ViewAction =
  | { type: 'open-custom-command'; preservedLeftIndex: number }
  | { type: 'open-custom-model'; backend: BackendOption }
  | { type: 'close' };

interface ViewState {
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
      return { ...state, view: { kind: 'custom-model', backend: action.backend } };
    case 'close':
      return { ...state, view: { kind: 'picker' } };
  }
}

export function ToolModelPicker({ role, stepLabel, onConfirm, onCancel }: ToolModelPickerProps) {
  const isPlanner = role === 'planner';
  const commit = (updated: Config, message: string) => {
    if (onConfirm) {
      onConfirm(updated);
      return;
    }
    configStore.save(updated);
    feedbackStore.setMessage(message);
    overlayStore.close();
  };
  const t = useTheme();
  const config = configStore.useConfig();
  const { cols, rows } = useResponsiveLayout();
  const focusModels = overlayStore.get().focus === 'models';

  const plannerDetections = detectionStore.use(s => s.planners);
  const implementerDetections = detectionStore.use(s => s.implementers);
  const loading = detectionStore.use(s => s.loading);
  const detections = isPlanner ? plannerDetections : implementerDetections;

  const [viewState, dispatchView] = useReducer(viewReducer, initialViewState);
  const [selectedBackend, setSelectedBackend] = useState<BackendOption | null>(null);

  const backends = isPlanner
    ? (plannerDetections ? buildPlannerOptions(plannerDetections) : [])
    : (implementerDetections ? buildImplementerOptions(implementerDetections) : []);
  const shellIndex = backends.findIndex(b => b.kind === 'shell');

  const configId = isPlanner
    ? config.planner.tool
    : (selectedBackend?.id ?? config.implementer.type ?? config.implementer.provider);
  const configBackendIndex = backends.findIndex(b => b.id === configId);
  const initialLeftIdx = focusModels && configBackendIndex >= 0 ? configBackendIndex : viewState.preservedLeftIndex;

  const customModels = isPlanner
    ? (config.planner.customModels ?? [])
    : (config.implementer.customModels ?? []);

  const currentBackend = backends.find(b => b.id === configId) ?? backends[0];

  const rightModels: ModelOption[] = (() => {
    const customOptions = customModels.map(id => ({ id, isCustom: true }));
    if (isPlanner) {
      const knownModels = modelsForPlannerBackend(config.planner.tool);
      return [...customOptions, ...knownModels];
    }
    const knownModels = implementerDetections && currentBackend
      ? modelsForImplementerBackend(implementerDetections, currentBackend.id, currentBackend.kind)
      : [];
    return [...customOptions, ...knownModels];
  })();

  const roleLabel = isPlanner ? 'Planner' : 'Implementer';
  const currentModel = isPlanner ? config.planner.model : config.implementer.model;
  const currentCommand = isPlanner ? config.planner.command : config.implementer.command;

  if (!detections || loading) {
    return (
      <Box width={cols} height={rows} alignItems="center" justifyContent="center">
        <Spinner label={isPlanner ? 'Detecting planners...' : 'Detecting providers...'} color={t.accent} />
      </Box>
    );
  }

  if (viewState.view.kind === 'custom-command') {
    return (
      <TextInputOverlay
        title={`Custom ${roleLabel} Command`}
        label="Command to run:"
        placeholder="e.g. my-ai-tool --format stream-json"
        initialValue={currentCommand ?? ''}
        rows={1}
        maxRows={3}
        onCancel={() => dispatchView({ type: 'close' })}
        onSubmit={(cmd) => {
          const updated = isPlanner
            ? { ...config, planner: { ...config.planner, tool: 'shell' as const, command: cmd } }
            : { ...config, implementer: { ...config.implementer, type: 'shell' as const, command: cmd } };
          commit(updated, `${roleLabel} set to: shell: ${cmd}`);
        }}
      />
    );
  }

  if (viewState.view.kind === 'custom-model') {
    const customModelBackend = viewState.view.backend;
    return (
      <TextInputOverlay
        title={`Custom ${roleLabel} Model`}
        label={
          <>Enter a custom model ID for <Text color={t.accent}>{customModelBackend.displayName}</Text>:</>
        }
        placeholder="e.g. my-org/custom-model or llama3.3:latest"
        examples={[
          'llama3.3:70b-instruct-q4_K_M',
          'anthropic/claude-3-opus-20240229',
          'deepseek/deepseek-chat',
        ]}
        onCancel={() => dispatchView({ type: 'close' })}
        onSubmit={(modelName) => {
          const existingCustom = customModels;
          const newCustomModels = existingCustom.includes(modelName)
            ? existingCustom
            : [...existingCustom, modelName];

          let updated: Config;
          if (isPlanner) {
            updated = {
              ...config,
              planner: {
                ...config.planner,
                tool: customModelBackend.id as PlannerTool,
                model: modelName,
                customModels: newCustomModels,
              },
            };
          } else {
            const isTool = customModelBackend.kind === 'cli';
            const providerDef = isTool ? null : getProvider(customModelBackend.id);
            updated = {
              ...config,
              implementer: {
                ...config.implementer,
                ...(isTool ? { type: customModelBackend.id as Config['implementer']['type'] } : {
                  type: 'api' as const,
                  provider: customModelBackend.id,
                  ...(customModelBackend.id !== config.implementer.provider && providerDef && { apiBase: providerDef.baseURL }),
                }),
                model: modelName,
                customModels: newCustomModels,
              },
            };
          }
          commit(updated, `${roleLabel} set to: ${customModelBackend.displayName} › ${formatModelName(modelName)}`);
        }}
      />
    );
  }

  const handleConfirm = (backend: BackendOption, model: ModelOption | null) => {
    if (backend.kind === 'shell') {
      dispatchView({ type: 'open-custom-command', preservedLeftIndex: shellIndex >= 0 ? shellIndex : 0 });
      return;
    }

    const label = model ? `${backend.displayName} › ${formatModelName(model.id)}` : backend.displayName;

    if (isPlanner) {
      const updates: Partial<typeof config.planner> = { tool: backend.id as PlannerTool };
      updates.model = model ? model.id : undefined;
      const updated = { ...config, planner: { ...config.planner, ...updates } };
      commit(updated, `Planner set to: ${label}`);
      return;
    }

    if (backend.kind === 'cli') {
      const updated = {
        ...config,
        implementer: {
          ...config.implementer,
          type: backend.id as Config['implementer']['type'],
          ...(model && { model: model.id }),
        },
      };
      commit(updated, `Implementer set to: ${label}`);
      return;
    }

    const providerChanged = backend.id !== config.implementer.provider;
    const providerDef = getProvider(backend.id);
    const updated = {
      ...config,
      implementer: {
        ...config.implementer,
        type: 'api' as const,
        provider: backend.id,
        ...(model && { model: model.id }),
        ...(providerChanged && { apiBase: providerDef.baseURL }),
      },
    };
    commit(updated, `Implementer set to: ${label}`);
  };

  const handleLeftChange = (item: BackendOption) => {
    if (!isPlanner && item.kind !== 'shell') {
      setSelectedBackend(item);
    }
  };

  const handleDeleteRight = (item: ModelOption) => {
    const newCustomModels = customModels.filter(m => m !== item.id);
    const updated = isPlanner
      ? { ...config, planner: { ...config.planner, customModels: newCustomModels } }
      : { ...config, implementer: { ...config.implementer, customModels: newCustomModels } };
    configStore.save(updated);
    feedbackStore.setMessage(`Removed custom model: ${item.id}`);
  };

  const isConfigMatch = (item: BackendOption) => {
    if (isPlanner) return item.id === config.planner.tool;
    if (item.kind === 'cli') return item.id === config.implementer.type;
    return item.id === config.implementer.provider;
  };

  const renderBackendRow = (item: BackendOption, isCursor: boolean, isSelected: boolean, maxWidth: number) => {
    const isShell = item.kind === 'shell';
    const dimmed = !item.available && !isShell;
    const rawLabel = isShell
      ? (currentCommand ? `shell: ${currentCommand}` : '+ Add custom...')
      : item.displayName;
    const labelColor = dimmed ? t.textDim : isCursor ? t.accent : t.text;
    const showCheck = (isSelected || isConfigMatch(item)) && !dimmed;
    const { label, suffix } = formatBackendLine(
      rawLabel,
      isShell ? null : item.badge,
      isShell ? null : (isPlanner ? item.version ?? null : null),
      dimmed ? '(unavailable)' : null,
      showCheck,
      maxWidth,
    );
    return (
      <Text>
        <Text color={labelColor} bold={isCursor && !dimmed}>{label}</Text>
        <Text color={showCheck && suffix.endsWith('\u2713') ? t.success : t.textDim}>
          {suffix.replace(' \u2713', '')}
        </Text>
        {showCheck && <Text color={t.success}> {'\u2713'}</Text>}
      </Text>
    );
  };

  const renderModelRow = (item: ModelOption, isCursor: boolean, maxWidth: number) => {
    const isCfgMatch = item.id === currentModel;
    const isCustom = 'isCustom' in item && Boolean(item.isCustom);
    const modelName = formatModelName(item.id);
    const suffixParts: string[] = [];
    if (isCustom) suffixParts.push(' (custom)');
    if (item.isDefault) suffixParts.push(' (default)');
    if (isCfgMatch) suffixParts.push(' \u2713');
    const suffix = suffixParts.join('');
    const truncatedName = truncateText(modelName, maxWidth - suffix.length);
    return (
      <Text>
        <Text color={isCursor ? t.accent : t.text} bold={isCursor}>{truncatedName}</Text>
        {isCustom && <Text color={t.textDim}> (custom)</Text>}
        {item.isDefault && <Text color={t.textDim}> (default)</Text>}
        {isCfgMatch && <Text color={t.success}> {'\u2713'}</Text>}
      </Text>
    );
  };

  return (
    <TwoColumnPicker<BackendOption, ModelOption>
      title={roleLabel}
      stepLabel={stepLabel}
      leftLabel="Tools"
      rightLabel="Models"
      leftItems={backends}
      rightItems={rightModels}
      leftGetKey={item => item.id}
      rightGetKey={item => item.id}
      isLeftItemSpecial={item => item.kind === 'shell'}
      isLeftItemDisabled={item => !item.available && item.kind !== 'shell'}
      onLeftChange={handleLeftChange}
      onConfirm={handleConfirm}
      initialLeftIndex={initialLeftIdx}
      customLeftHelp={
        <Box flexDirection="column" marginTop={1} paddingX={1}>
          <Text color={t.textDim}>Run a custom shell command as the {role}.</Text>
          <Text color={t.textDim}>Press Enter to configure the command.</Text>
        </Box>
      }
      onCancel={onCancel ?? (() => overlayStore.close())}
      initialColumn={focusModels ? 'right' : 'left'}
      allowCustomRight
      onCustomRightOverlay={(backend) => dispatchView({ type: 'open-custom-model', backend })}
      onDeleteRight={handleDeleteRight}
      isRightItemCustom={(item) => 'isCustom' in item && Boolean(item.isCustom)}
      leftRenderRow={renderBackendRow}
      rightRenderRow={renderModelRow}
    />
  );
}
