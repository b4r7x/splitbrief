import { Box, Text } from 'ink';
import { SOFT_SEP } from '../../components/separators.js';
import { useTheme } from '../../components/theme.js';
import { OverlayPanel } from '../../components/overlays/overlay-panel.js';
import { configStore } from '../../stores/project/config.js';
import { overlayStore } from '../../stores/ui/overlay.js';
import { feedbackStore } from '../../stores/ui/feedback.js';
import { terminalSizeStore } from '../../stores/ui/terminal-size.js';
import { CursorCell } from '../../components/pickers/cursor-cell.js';
import { useStaticSelector } from '../../hooks/use-static-selector.js';
import { WORKFLOW_MODES, type WorkflowMode } from '../../core/schemas/enums.js';
import { getWorkflowMode } from '../../core/config/accessors/values.js';

interface ModeDef {
  mode: WorkflowMode;
  cost: string;
  size: string;
}

const MODE_METADATA: Record<WorkflowMode, { cost: string; size: string }> = {
  instant: { cost: `1 call${SOFT_SEP}no approval`, size: 'trivial edits' },
  quick: { cost: `1 call${SOFT_SEP}no approval`, size: 'small fixes' },
  standard: { cost: `4 calls${SOFT_SEP}1 approval`, size: 'features' },
  speckit: { cost: `6-7 calls${SOFT_SEP}2 approvals`, size: 'large scope' },
};

const MODES: readonly ModeDef[] = WORKFLOW_MODES.map((mode) => ({
  mode,
  ...MODE_METADATA[mode],
}));

export function ModeSelector() {
  const t = useTheme();
  const isSmall = terminalSizeStore.use((s) => s.isSmall);
  const config = configStore.useConfig();
  const currentMode = getWorkflowMode(config);
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
