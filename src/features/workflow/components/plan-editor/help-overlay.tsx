import { Box, Text } from 'ink';
import { useTheme } from '../../../../components/theme.js';
import { OverlayPanel } from '../../../../components/overlays/overlay-panel.js';
import { overlayStore } from '../../../../stores/ui/overlay.js';
import { getPlanEditorHelpRows } from './footer.js';

export function PlanEditorHelpOverlay() {
  const t = useTheme();
  const isActive = overlayStore.use((s) => s.active === 'plan-editor-help');
  if (!isActive) return null;

  return (
    <OverlayPanel title="Plan Editor Keys" hint="press any key to dismiss" width="auto">
      <Box flexDirection="column">
        {getPlanEditorHelpRows().map((row) => (
          <Box key={`${row.context}:${row.key}:${row.label}`} gap={2}>
            <Text color={t.textDim}>{row.context.padEnd(8)}</Text>
            <Text color={t.accent}>{row.key.padEnd(16)}</Text>
            <Text color={t.text}>{row.label}</Text>
          </Box>
        ))}
      </Box>
    </OverlayPanel>
  );
}
