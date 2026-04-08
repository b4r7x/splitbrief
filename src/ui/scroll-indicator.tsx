import { Text } from 'ink';

export function ScrollIndicator({ show, direction }: { show: boolean; direction: 'up' | 'down' }) {
  if (!show) return null;
  return <Text dimColor>  {direction === 'up' ? '↑' : '↓'} more</Text>;
}
