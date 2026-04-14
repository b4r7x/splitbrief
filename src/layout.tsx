import type { ReactNode } from 'react';
import { Box } from 'ink';
import { terminalSizeStore } from './stores/terminal-size.js';

interface LayoutProps {
  screen: ReactNode;
  overlay: ReactNode | null;
}

export function Layout({ screen, overlay }: LayoutProps) {
  const { cols, rows } = terminalSizeStore.use(s => s);
  const hasOverlay = overlay !== null;

  return (
    <Box width={cols} height={rows}>
      <Box display={hasOverlay ? 'none' : 'flex'} flexGrow={1}>
        {screen}
      </Box>
      {overlay}
    </Box>
  );
}
