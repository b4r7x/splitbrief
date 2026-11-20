import { Box } from 'ink';
import { useTheme, ThemeText as Text } from '../../../components/theme.js';
import { BOOT_MANIFEST_TITLE } from '../../../core/discovery/copy.js';
import { useSpinnerFrame } from '../../../hooks/use-spinner-frame.js';
import { borderStyleFor } from '../../../lib/glyphs.js';
import { detectionStore } from '../../../stores/discovery/detection.js';
import { deriveHomeToolCheck } from '../tool-check.js';

/**
 * The first tool check, boxed as wide as its words in the slack between the content block and the
 * composer. It exists only while that check runs, then vanishes without leaving a residue: the
 * slack absorbs it, so nothing above or below ever moves.
 */
export function ToolCheckBox() {
  const theme = useTheme();
  const cold = detectionStore.use((s) => deriveHomeToolCheck(s.refresh) === 'cold');
  const { frame } = useSpinnerFrame(cold);

  if (!cold) return null;
  return (
    <Box
      borderStyle={borderStyleFor('round')}
      borderColor={theme.accent}
      paddingX={1}
      flexShrink={0}
    >
      <Text color={theme.accent} bold>
        {frame} {BOOT_MANIFEST_TITLE}
      </Text>
    </Box>
  );
}
