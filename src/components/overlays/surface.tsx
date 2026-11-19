import { Box } from 'ink';
import type { ComponentPropsWithoutRef } from 'react';
import { useTheme } from '../theme.js';

export type PanelSurfaceProps = Omit<ComponentPropsWithoutRef<typeof Box>, 'backgroundColor'>;

export function PanelSurface(props: PanelSurfaceProps) {
  const theme = useTheme();
  return <Box {...props} backgroundColor={theme.overlayBg} />;
}
