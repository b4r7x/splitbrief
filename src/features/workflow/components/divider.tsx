import { Box, Text } from 'ink';
import { useTheme } from '../../../components/theme.js';
import {
  getTerminalCellWidth,
  sanitizeTerminalDisplayText,
  truncateTerminalDisplayTextMiddle,
} from '../../../utils/display-text.js';

export interface DividerProps {
  width: number;
  label?: string;
  tone?: 'border' | 'textDim';
}

export function Divider({ width, label, tone = 'border' }: DividerProps) {
  const t = useTheme();
  const color = tone === 'border' ? t.border : t.textDim;
  const cleanLabel = label === undefined ? undefined : sanitizeTerminalDisplayText(label);
  if (cleanLabel === undefined || cleanLabel === '') {
    const rule = '─'.repeat(Math.max(0, width));
    return (
      <Box height={1} overflow="hidden" flexShrink={0} width={width}>
        <Text color={color}>{rule}</Text>
      </Box>
    );
  }
  const labelBudget = Math.max(0, width - 2);
  const labelCell =
    width > 2 ? ` ${truncateTerminalDisplayTextMiddle(cleanLabel, labelBudget)} ` : '';
  const side = Math.max(0, width - getTerminalCellWidth(labelCell));
  const left = Math.floor(side / 2);
  const right = side - left;
  return (
    <Box height={1} overflow="hidden" flexShrink={0} width={width}>
      <Text color={color}>{'─'.repeat(left)}</Text>
      <Text color={color}>{labelCell}</Text>
      <Text color={color}>{'─'.repeat(right)}</Text>
    </Box>
  );
}
