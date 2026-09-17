import type { ReactNode } from 'react';
import { Box } from 'ink';

interface LayoutProps {
  screen: ReactNode;
  overlay: ReactNode | null;
  sessionPreparation?: ReactNode | undefined;
  /**
   * A preparation owns the page only when the operator has something to do on it: approve the
   * attempt, or repair what stopped it. The routine check leaves the screen where it is and says
   * so beside the composer, so the run and the draft on it stay put.
   */
  sessionPreparationTakesPage?: boolean | undefined;
}

export function Layout({
  screen,
  overlay,
  sessionPreparation,
  sessionPreparationTakesPage = false,
}: LayoutProps) {
  // Whatever covers the screen hides it the same way: mounted, so the draft and the run behind it
  // survive the panel, and painted again the moment the panel stands down.
  const covered = overlay !== null || sessionPreparationTakesPage;

  return (
    <Box>
      <Box display={covered ? 'none' : 'flex'} flexGrow={1}>
        {screen}
      </Box>
      {sessionPreparation}
      {overlay}
    </Box>
  );
}
