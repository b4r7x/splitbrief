import { useState, useEffect } from 'react';
import { Box, Text } from 'ink';
import { useTheme } from '../ui/theme.js';
import { Spinner } from '../ui/spinner.js';
import { TwoColumnPicker } from './two-column-picker.js';
import { configStore } from '../stores/config.js';
import { overlayStore } from '../stores/overlay.js';
import { feedbackStore } from '../stores/error.js';
import { detectAvailableImplementers } from '../engine/detection.js';
import { getProvider } from '../engine/providers/registry.js';
import { useResponsiveLayout } from '../hooks/use-terminal-size.js';
import { useAsyncDetection } from '../hooks/use-async-detection.js';
import { useShellCommand } from '../hooks/use-shell-command.js';
import type { ProviderDetection } from '../engine/providers/types.js';

interface BackendItem {
  provider: string;
  isLocal: boolean;
  available: boolean;
  modelCount: number;
}

interface ModelItem {
  model: string;
}

export function buildBackendItems(detections: ProviderDetection[]): BackendItem[] {
  const items: BackendItem[] = detections.map(d => ({
    provider: d.provider,
    isLocal: d.isLocal,
    available: d.available,
    modelCount: d.models?.length ?? 0,
  }));
  items.push({ provider: 'shell', isLocal: false, available: true, modelCount: 0 });
  return items;
}

export function modelsForProvider(detections: ProviderDetection[], provider: string): ModelItem[] {
  const d = detections.find(det => det.provider === provider);
  return (d?.models ?? []).map(m => ({ model: m }));
}

export function ImplementerPicker() {
  const t = useTheme();
  const config = configStore.useConfig();
  const { cols, rows } = useResponsiveLayout();

  const detections = useAsyncDetection(detectAvailableImplementers);
  const [shellActive, setShellActive] = useState(false);
  const [selectedProvider, setSelectedProvider] = useState<string | null>(null);
  const effectiveProvider = selectedProvider ?? config.implementer.provider;
  const rightModels = detections && !shellActive
    ? modelsForProvider(detections, effectiveProvider)
    : [];

  useEffect(() => {
    overlayStore.setExclusive(shellActive);
  }, [shellActive]);

  const shell = useShellCommand(config.implementer.command ?? '', {
    isActive: shellActive,
    onCancel: () => setShellActive(false),
    onSubmit: (cmd) => {
      const updated = { ...config, implementer: { ...config.implementer, type: 'shell' as const, command: cmd } };
      configStore.save(updated);
      feedbackStore.setMessage(`Implementer set to: shell: ${cmd}`);
      overlayStore.close();
    },
  });

  if (!detections) {
    return (
      <Box width={cols} height={rows} alignItems="center" justifyContent="center">
        <Spinner label="Detecting providers..." color={t.accent} />
      </Box>
    );
  }

  const backends = buildBackendItems(detections);
  const currentModel = config.implementer.model;

  return (
    <TwoColumnPicker<BackendItem, ModelItem>
      title="Implementer"
      leftItems={backends}
      rightItems={shellActive ? [] : rightModels}
      inputDisabled={shellActive}
      leftLabel="Providers"
      rightLabel="Models"
      leftGetKey={item => item.provider}
      rightGetKey={item => item.model}
      leftFilterFn={(item, q) => item.provider.toLowerCase().includes(q.toLowerCase())}
      rightFilterFn={(item, q) => item.model.toLowerCase().includes(q.toLowerCase())}
      leftRenderRow={(item, isCursor) => {
        const locality = item.provider === 'shell'
          ? 'custom command'
          : item.isLocal ? 'local, free' : 'remote';
        const isSelected = item.provider === effectiveProvider;
        return (
          <Box>
            <Text color={isCursor ? t.accent : t.text} bold={isCursor}>{item.provider}</Text>
            <Text color={t.textDim}>  {locality}</Text>
            {isSelected && <Text color={t.success}> {'\u2713'}</Text>}
          </Box>
        );
      }}
      rightRenderRow={(item, isCursor) => {
        const isCurrent = item.model === currentModel;
        return (
          <Box>
            <Text color={isCursor ? t.accent : t.text} bold={isCursor}>{item.model}</Text>
            {isCurrent && <Text color={t.success}> {'\u2713'}</Text>}
          </Box>
        );
      }}
      onLeftChange={item => {
        const isShell = item.provider === 'shell';
        setShellActive(isShell);
        if (!isShell) setSelectedProvider(item.provider);
      }}
      onConfirm={(left, right) => {
        if (left.provider === 'shell') return;

        const providerChanged = left.provider !== config.implementer.provider;
        const providerDef = getProvider(left.provider);
        const updated = {
          ...config,
          implementer: {
            ...config.implementer,
            provider: left.provider,
            ...(right && { model: right.model }),
            ...(providerChanged && { apiBase: providerDef.baseURL }),
          },
        };
        const label = right ? `${left.provider} \u203a ${right.model}` : left.provider;
        configStore.save(updated);
        feedbackStore.setMessage(`Implementer set to: ${label}`);
        overlayStore.close();
      }}
      onCancel={() => overlayStore.close()}
      rightPlaceholder={shellActive ? (
        <Box flexDirection="column" paddingX={1} paddingY={1}>
          <Text color={t.textDim}>Enter the command to run as implementer:</Text>
          <Box borderStyle="round" borderColor={t.accent} paddingX={1} marginTop={1}>
            <Text>{shell.commandBuffer}<Text color={t.accent}>|</Text></Text>
          </Box>
        </Box>
      ) : undefined}
    />
  );
}
