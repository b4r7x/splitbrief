import type { ReactNode } from 'react';
import { Box, useInput } from 'ink';
import { useResponsiveLayout } from './hooks/use-terminal-size.js';
import { overlayStore } from './stores/overlay.js';

interface LayoutProps {
  screen: ReactNode;
  overlay: ReactNode | null;
}

export function Layout({ screen, overlay }: LayoutProps) {
  const { cols, rows } = useResponsiveLayout();
  const hasOverlay = overlay !== null;
  const exclusive = overlayStore.use(s => s.exclusive);

  useInput(
    (_input, key) => {
      if (key.escape) overlayStore.close();
    },
    { isActive: hasOverlay && !exclusive },
  );

  return (
    <Box width={cols} height={rows}>
      <Box display={hasOverlay ? 'none' : 'flex'} flexGrow={1}>
        {screen}
      </Box>
      {overlay}
    </Box>
  );
}
