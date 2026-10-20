import { ThemeText as Text, useTheme } from './theme.js';
import { SOFT_SEP } from '../core/separators.js';

export function ScrollIndicator({
  show,
  direction,
  count,
}: {
  show: boolean;
  direction: 'up' | 'down' | 'both';
  count?: number;
}) {
  const t = useTheme();
  if (!show) return null;
  const down = count === undefined ? '↓ more' : `↓ ${count} more`;
  const text =
    direction === 'up' ? '↑ more' : direction === 'down' ? down : `↑ more${SOFT_SEP}${down}`;
  return <Text color={t.scrollIndicator}> {text}</Text>;
}
