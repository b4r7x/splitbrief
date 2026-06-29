import type { ReactNode } from 'react';
import { Box } from 'ink';

interface LayoutProps {
  screen: ReactNode;
  overlay: ReactNode | null;
}

export function Layout({ screen, overlay }: LayoutProps) {
  const hasOverlay = overlay !== null;

  return (
    <Box>
      <Box display={hasOverlay ? 'none' : 'flex'} flexGrow={1}>
        {screen}
      </Box>
      {overlay}
    </Box>
  );
}
