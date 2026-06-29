import { Text } from 'ink';
import { useTheme } from '../theme.js';
import { cursorGlyph, NO_CURSOR } from './cursor-glyph.js';

interface CursorCellProps {
  isCursor: boolean;
  dimWhenInactive?: boolean;
}

export function CursorCell({ isCursor, dimWhenInactive = false }: CursorCellProps) {
  const t = useTheme();
  const color = isCursor ? t.accent : dimWhenInactive ? t.textDim : t.text;
  return <Text color={color}>{isCursor ? cursorGlyph() : NO_CURSOR}</Text>;
}
