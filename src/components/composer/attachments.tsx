import { Box, Text } from 'ink';
import { useTheme } from '../theme.js';
import { useStores } from '../../stores/use-stores.js';
import { attachmentShortName } from '../../core/attachments/resolve.js';
import { attachmentsStore } from '../../stores/workflow/attachments.js';

export function AttachmentChips() {
  const theme = useTheme();
  const [{ pending }] = useStores(attachmentsStore);
  if (pending.length === 0) return null;
  return (
    <Box flexDirection="row" flexWrap="wrap" paddingX={1}>
      {pending.map((a, i) => (
        <Box key={a.id} marginRight={1}>
          <Text color={theme.info}>📎 {i + 1}: {attachmentShortName(a.path)}</Text>
        </Box>
      ))}
    </Box>
  );
}
