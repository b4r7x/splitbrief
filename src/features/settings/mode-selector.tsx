import { Box, Text } from 'ink';
import { useTheme } from '../../components/theme.js';
import { OverlayPanel } from '../../components/overlays/overlay-panel.js';
import { configStore } from '../../stores/project/config.js';
import { overlayStore } from '../../stores/ui/overlay.js';
import { feedbackStore } from '../../stores/ui/feedback.js';
import { terminalSizeStore } from '../../stores/ui/terminal-size.js';
import { CursorCell } from '../../components/pickers/cursor-cell.js';
import { useStaticSelector } from '../../hooks/use-static-selector.js';
import type { WorkflowMode } from '../../core/schemas/enums.js';

interface ModeDef {
  mode: WorkflowMode;
  cost: string;
  size: string;
}

const MODES: readonly ModeDef[] = [
  { mode: 'instant', cost: '1 call · no approval', size: 'trivial edits' },
  { mode: 'quick', cost: '1 call · no approval', size: 'small fixes' },
  { mode: 'standard', cost: '4 calls · 1 approval', size: 'features' },
  { mode: 'speckit', cost: '6-7 calls · 2 approvals', size: 'large scope' },
];

export function ModeSelector() {
  const t = useTheme();
  const isSmall = terminalSizeStore.use((s) => s.isSmall);
  const config = configStore.useConfig();
  const currentMode = config.workflow.mode ?? 'standard';
  const currentIdx = MODES.findIndex((m) => m.mode === currentMode);

  const { selectedIndex } = useStaticSelector<ModeDef>({
    items: MODES,
    initialIndex: currentIdx,
    onSelect: (item) => {
      const updated = { ...config, workflow: { ...config.workflow, mode: item.mode } };
      const result = configStore.save(updated, { changedPaths: ['workflow.mode'] });
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
      hint="↑↓ select  Enter confirm  Esc cancel"
      maxWidth={isSmall ? 55 : 68}
    >
      {MODES.map((m, i) => {
        const isSelected = i === selectedIndex;
        const isCurrent = m.mode === currentMode;
        return (
          <Box
            key={m.mode}
            flexDirection="column"
            marginBottom={i < MODES.length - 1 && !isSmall ? 1 : 0}
          >
            <Box>
              <CursorCell isCursor={isSelected} dimWhenInactive />
              <Box width={12}>
                <Text color={isSelected ? t.text : t.textDim} bold={isSelected}>
                  {m.mode}
                </Text>
              </Box>
              {isCurrent && <Text color={t.success}>✓ </Text>}
              <Box flexGrow={1}>
                <Text color={t.textDim}>{m.cost}</Text>
              </Box>
              {isSmall && <Text color={isSelected ? t.text : t.textDim}> {m.size}</Text>}
            </Box>
            {!isSmall && (
              <Box marginLeft={4}>
                <Text color={isSelected ? t.text : t.textDim}>{m.size}</Text>
              </Box>
            )}
          </Box>
        );
      })}
    </OverlayPanel>
  );
}
