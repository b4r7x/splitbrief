import { useState } from 'react';
import { Box, Text } from 'ink';
import { useTheme } from '../ui/theme.js';
import { Spinner } from '../ui/spinner.js';
import { TwoColumnPicker } from './two-column-picker.js';
import { configStore } from '../stores/config.js';
import { overlayStore } from '../stores/overlay.js';
import { feedbackStore } from '../stores/error.js';
import { detectAvailablePlanners } from '../engine/detection.js';
import { truncate } from '../utils/format.js';
import { useResponsiveLayout } from '../hooks/use-terminal-size.js';
import { useAsyncDetection } from '../hooks/use-async-detection.js';
import { useShellCommand } from '../hooks/use-shell-command.js';
import type { PlannerDetection } from '../engine/detection.js';
import { KNOWN_PLANNER_MODELS as KNOWN_MODELS } from './known-planner-models.js';
import type { KnownModel } from './known-planner-models.js';
function typeLabel(d: PlannerDetection): string {
  if (d.type === 'shell') return 'Custom';
  return d.type === 'cli' ? 'CLI' : 'API';
}

export function PlannerPicker() {
  const t = useTheme();
  const config = configStore.useConfig();
  const { cols, rows } = useResponsiveLayout();

  const planners = useAsyncDetection(detectAvailablePlanners);
  const [rightModels, setRightModels] = useState<KnownModel[]>(() =>
    KNOWN_MODELS[config.planner.tool] ?? [],
  );
  const [shellActive, setShellActive] = useState(false);

  const shell = useShellCommand(config.planner.command ?? '', {
    isActive: shellActive,
    onCancel: () => setShellActive(false),
    onSubmit: (cmd) => {
      const updated = { ...config, planner: { ...config.planner, tool: 'shell' as const, command: cmd } };
      configStore.save(updated);
      feedbackStore.setMessage(`Planner set to: shell: ${cmd}`);
      overlayStore.close();
    },
  });

  if (!planners) {
    return (
      <Box width={cols} height={rows} alignItems="center" justifyContent="center">
        <Spinner label="Detecting planners..." color={t.accent} />
      </Box>
    );
  }

  const currentTool = config.planner.tool;
  const currentModel = config.planner.model;
  const available = planners.filter(p => p.available);
  const unavailable = planners.filter(p => !p.available);

  return (
    <TwoColumnPicker<PlannerDetection, KnownModel>
      title="Planner"
      leftLabel="Backends"
      rightLabel="Models"
      leftItems={available}
      rightItems={shellActive ? [] : rightModels}
      inputDisabled={shellActive}
      leftGetKey={item => item.tool}
      rightGetKey={item => item.name}
      leftFilterFn={(item, q) => item.tool.toLowerCase().includes(q.toLowerCase())}
      rightFilterFn={(item, q) => item.name.toLowerCase().includes(q.toLowerCase())}
      onLeftChange={item => {
        const isShell = item.tool === 'shell';
        setRightModels(KNOWN_MODELS[item.tool] ?? []);
        setShellActive(isShell);
        if (isShell) shell.setCommandBuffer(config.planner.command ?? '');
      }}
      onConfirm={(backend, model) => {
        if (backend.tool === 'shell') return;

        const updates: Partial<typeof config.planner> = { tool: backend.tool };
        updates.model = model ? model.name : undefined;

        const label = model ? `${backend.tool} / ${model.name}` : backend.tool;
        const updated = { ...config, planner: { ...config.planner, ...updates } };
        configStore.save(updated);
        feedbackStore.setMessage(`Planner set to: ${label}`);
        overlayStore.close();
      }}
      onCancel={() => overlayStore.close()}
      leftRenderRow={(item, isCursor) => {
        const name = truncate(item.tool, 18).padEnd(18);
        const isCfgMatch = item.tool === currentTool;
        return (
          <Box>
            <Text color={isCursor ? t.accent : t.text} bold={isCursor}>{name}</Text>
            <Text color={t.textDim}>  {typeLabel(item).padEnd(8)}</Text>
            {item.version && <Text color={t.textDim}>v{item.version}  </Text>}
            {isCfgMatch && <Text color={t.success}>{'\u2713'}</Text>}
          </Box>
        );
      }}
      rightRenderRow={(item, isCursor) => {
        const name = truncate(item.name, 34).padEnd(34);
        const isCfgMatch = item.name === currentModel;
        return (
          <Box>
            <Text color={isCursor ? t.accent : t.text} bold={isCursor}>{name}</Text>
            {item.isDefault && <Text color={t.textDim}>  (default)</Text>}
            {isCfgMatch && <Text color={t.success}>  {'\u2713'}</Text>}
          </Box>
        );
      }}
      rightPlaceholder={shellActive ? (
        <Box flexDirection="column" paddingTop={1}>
          <Text color={t.textDim}>Enter command:</Text>
          <Box borderStyle="round" borderColor={t.accent} paddingX={1} marginTop={1}>
            <Text>{shell.commandBuffer}<Text color={t.accent}>|</Text></Text>
          </Box>
        </Box>
      ) : unavailable.length > 0 ? (
        <Box flexDirection="column" marginTop={1}>
          <Text color={t.textDim} dimColor>  Unavailable:</Text>
          {unavailable.map(p => (
            <Text key={p.tool} color={t.textDim} dimColor>    {p.tool}</Text>
          ))}
        </Box>
      ) : undefined}
    />
  );
}
