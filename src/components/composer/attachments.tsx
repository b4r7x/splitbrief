import { Box, Text } from 'ink';
import { useTheme } from '../theme.js';
import { useStores } from '../../stores/use-stores.js';
import { attachmentShortName } from '../../core/attachments/resolve.js';
import { attachmentsStore } from '../../stores/workflow/attachments.js';
import { getTerminalCellWidth, truncateTerminalDisplayText } from '../../utils/display-text.js';

const ATTACHMENT_CHIP_MAX_CELLS = 32;

export function attachmentChipLabel(path: string, index: number): string {
  const prefix = `📎 ${index + 1}: `;
  const maxNameCells = Math.max(1, ATTACHMENT_CHIP_MAX_CELLS - getTerminalCellWidth(prefix));
  return `${prefix}${truncateTerminalDisplayText(attachmentShortName(path), maxNameCells)}`;
}

export function AttachmentChips() {
  const theme = useTheme();
  const [{ pending }] = useStores(attachmentsStore);
  if (pending.length === 0) return null;
  return (
    <Box flexDirection="row" flexWrap="wrap" paddingX={1}>
      {pending.map((a, i) => (
        <Box key={a.id} marginRight={1}>
          <Text color={theme.info}>{attachmentChipLabel(a.path, i)}</Text>
        </Box>
      ))}
    </Box>
  );
}
