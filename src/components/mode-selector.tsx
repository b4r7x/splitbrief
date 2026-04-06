import { useState } from 'react';
import { Box, Text, useInput } from 'ink';
import { useTheme } from '../ui/theme.js';
import { OverlayPanel } from '../ui/overlay-panel.js';
import { configStore } from '../stores/config.js';
import { overlayStore } from '../stores/overlay.js';
import { feedbackStore } from '../stores/error.js';
import type { WorkflowMode } from '../types.js';

const MODES: { mode: WorkflowMode; calls: number; approvals: number; size: string }[] = [
  { mode: 'quick', calls: 1, approvals: 0, size: 'small fixes' },
  { mode: 'standard', calls: 4, approvals: 1, size: 'features' },
  { mode: 'full', calls: 4, approvals: 2, size: 'large scope' },
];

export function ModeSelector() {
  const t = useTheme();
  const config = configStore.use(s => s.config);
  const currentMode = config?.workflow.mode ?? 'standard';
  const currentIdx = MODES.findIndex(m => m.mode === currentMode);
  const [selected, setSelected] = useState(Math.max(0, currentIdx));

  useInput((input, key) => {
    if (key.upArrow) setSelected(prev => (prev > 0 ? prev - 1 : MODES.length - 1));
    if (key.downArrow) setSelected(prev => (prev < MODES.length - 1 ? prev + 1 : 0));
    if (key.return && config) {
      const mode = MODES[selected].mode;
      const updated = { ...config, workflow: { ...config.workflow, mode } };
      configStore.save(updated);
      feedbackStore.setMessage(`Mode set to: ${mode}`);
      overlayStore.close();
    }
    if (key.escape) overlayStore.close();
  });

  if (!config) return null;

  return (
    <OverlayPanel
      title="Workflow Mode"
      hint={'\u2191\u2193 select  Enter confirm  Esc cancel'}
      compact
      maxWidth={55}
    >
      {MODES.map((m, i) => {
        const isSelected = i === selected;
        const isCurrent = m.mode === currentMode;
        return (
          <Box key={m.mode} justifyContent="space-between">
            <Text color={isSelected ? t.accent : t.textDim}>
              {isSelected ? '\u25B8 ' : '  '}
              <Text color={isSelected ? t.text : t.textDim} bold={isSelected}>
                {m.mode}
              </Text>
            </Text>
            <Box gap={1}>
              <Text color={t.textDim}>
                {m.calls} call{m.calls === 1 ? '' : 's'} {'\u00B7'} {m.approvals} approval{m.approvals === 1 ? '' : 's'} {'\u00B7'} {m.size}
              </Text>
              {isCurrent && <Text color={t.success}>{'\u2713'}</Text>}
            </Box>
          </Box>
        );
      })}
    </OverlayPanel>
  );
}
