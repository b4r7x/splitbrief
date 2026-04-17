import { Box, Text } from 'ink';
import { useTheme } from '../theme.js';
import { OverlayPanel } from './overlay-panel.js';
import { configStore } from '../../stores/project/config.js';
import { overlayStore } from '../../stores/ui/overlay.js';
import { feedbackStore } from '../../stores/ui/feedback.js';
import { CursorCell } from '../pickers/cursor-cell.js';
import { useStaticSelector } from '../../hooks/use-static-selector.js';
import type { WorkflowMode } from '../../core/types/config-options.js';

interface ModeDef {
  mode: WorkflowMode;
  calls: number;
  approvals: number;
  size: string;
}

const MODES: readonly ModeDef[] = [
  { mode: 'quick', calls: 1, approvals: 0, size: 'small fixes' },
  { mode: 'standard', calls: 4, approvals: 1, size: 'features' },
  { mode: 'full', calls: 4, approvals: 2, size: 'large scope' },
];

export function ModeSelector() {
  const t = useTheme();
  const config = configStore.useConfig();
  const currentMode = config.workflow.mode ?? 'standard';
  const currentIdx = MODES.findIndex(m => m.mode === currentMode);

  const { selectedIndex } = useStaticSelector<ModeDef>({
    items: MODES,
    initialIndex: currentIdx,
    onSelect: (item) => {
      const updated = { ...config, workflow: { ...config.workflow, mode: item.mode } };
      const result = configStore.save(updated);
      if (result.ok) {
        feedbackStore.setMessage(`Mode set to: ${item.mode}`);
        overlayStore.close();
      } else if (result.error) {
        feedbackStore.setError(`Failed to save config: ${result.error.message}`);
      }
    },
    onCancel: () => overlayStore.close(),
  });

  return (
    <OverlayPanel
      title="Workflow Mode"
      hint={'\u2191\u2193 select  Enter confirm  Esc cancel'}
      maxWidth={55}
    >
      {MODES.map((m, i) => {
        const isSelected = i === selectedIndex;
        const isCurrent = m.mode === currentMode;
        return (
          <Box key={m.mode}>
            <CursorCell isCursor={isSelected} dimWhenInactive />
            <Box width={10}>
              <Text color={isSelected ? t.text : t.textDim} bold={isSelected}>
                {m.mode}
              </Text>
            </Box>
            <Box width={9}>
              <Text color={t.textDim}>
                {m.calls} call{m.calls === 1 ? '' : 's'}
              </Text>
            </Box>
            <Box width={13}>
              <Text color={t.textDim}>
                {m.approvals} approval{m.approvals === 1 ? '' : 's'}
              </Text>
            </Box>
            <Box flexGrow={1}>
              <Text color={t.textDim}>{m.size}</Text>
            </Box>
            {isCurrent && <Text color={t.success}>{'\u2713'}</Text>}
          </Box>
        );
      })}
    </OverlayPanel>
  );
}
