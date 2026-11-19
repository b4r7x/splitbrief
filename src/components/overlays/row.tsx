import { Box } from 'ink';
import { useTheme } from '../theme.js';
import type { PanelSurfaceProps } from './surface.js';

export function PanelRow({ active, ...props }: PanelSurfaceProps & { active: boolean }) {
  const theme = useTheme();
  return <Box {...props} backgroundColor={active ? theme.selectionBg : undefined} />;
}
