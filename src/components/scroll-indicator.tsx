import { Text } from 'ink';
import { useTheme } from './theme.js';

export function ScrollIndicator({ show, direction }: { show: boolean; direction: 'up' | 'down' }) {
  const t = useTheme();
  if (!show) return null;
  return <Text color={t.scrollIndicator}> {direction === 'up' ? '↑' : '↓'} more</Text>;
}
