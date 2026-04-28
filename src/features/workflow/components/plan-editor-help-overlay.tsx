import { Box, Text } from 'ink';
import { useTheme } from '../../../components/theme.js';
import { OverlayPanel } from '../../../components/overlays/overlay-panel.js';
import { overlayStore } from '../../../stores/ui/overlay.js';

const HELP_ROWS: Array<[string, string]> = [
  ['j / ↓', 'Move cursor down'],
  ['k / ↑', 'Move cursor up'],
  ['<c-j> / <c-n>', 'Move task down'],
  ['<c-k> / <c-p>', 'Move task up'],
  ['d', 'Delete task'],
  ['m', 'Merge with previous task'],
  ['p', 'Toggle worker packet preview'],
  ['s', 'Split task (opens $EDITOR)'],
  ['e', 'Edit task in $EDITOR'],
  ['<enter>', 'Expand / collapse task body'],
  ['Y', 'Save changes and proceed'],
  ['q', 'Discard changes and return'],
  ['?', 'Show / hide this help'],
];

export function PlanEditorHelpOverlay() {
  const t = useTheme();
  const isActive = overlayStore.use(s => s.active === 'plan-editor-help');
  if (!isActive) return null;

  return (
    <OverlayPanel title="Plan Editor Keys" hint="press any key to dismiss" width="auto">
      <Box flexDirection="column">
        {HELP_ROWS.map(([key, desc]) => (
          <Box key={key} gap={2}>
            <Text color={t.accent}>{key.padEnd(16)}</Text>
            <Text color={t.text}>{desc}</Text>
          </Box>
        ))}
      </Box>
    </OverlayPanel>
  );
}
