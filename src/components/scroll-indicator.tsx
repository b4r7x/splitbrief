import { Text } from 'ink';
import { useTheme } from './theme.js';

export function ScrollIndicator({
  show,
  direction,
  count,
}: {
  show: boolean;
  direction: 'up' | 'down';
  count?: number;
}) {
  const t = useTheme();
  if (!show) return null;
  if (direction === 'down' && count !== undefined) {
    return <Text color={t.scrollIndicator}> ↓ {count} more</Text>;
  }
  return <Text color={t.scrollIndicator}> {direction === 'up' ? '↑' : '↓'} more</Text>;
}
