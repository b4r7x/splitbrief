import type { ReactNode } from 'react';
import { Box } from 'ink';

interface LayoutProps {
  screen: ReactNode;
  overlay: ReactNode | null;
  sessionPreparation?: ReactNode | undefined;
  sessionPreparationActive?: boolean | undefined;
}

export function Layout({
  screen,
  overlay,
  sessionPreparation,
  sessionPreparationActive = false,
}: LayoutProps) {
  const hasOverlay = overlay !== null;

  if (sessionPreparationActive) {
    return (
      <Box>
        <Box display={hasOverlay ? 'none' : 'flex'} flexGrow={1}>
          {sessionPreparation}
        </Box>
        {overlay}
      </Box>
    );
  }

  return (
    <Box>
      <Box display={hasOverlay ? 'none' : 'flex'} flexGrow={1}>
        {screen}
      </Box>
      {overlay}
    </Box>
  );
}
