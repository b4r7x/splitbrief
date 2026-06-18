import type { ReactNode } from 'react';
import { Box } from 'ink';
import { terminalSizeStore } from '../stores/ui/terminal-size.js';
import { useStores } from '../stores/use-stores.js';

interface ScreenShellProps {
  header?: ReactNode;
  footer?: ReactNode;
  children: ReactNode;
  justifyContent?: 'flex-start' | 'center' | 'flex-end';
  alignItems?: 'flex-start' | 'center' | 'flex-end';
  padding?: number;
}

export function ScreenShell({
  header,
  footer,
  children,
  justifyContent,
  alignItems,
  padding,
}: ScreenShellProps) {
  const [{ cols, rows }] = useStores(terminalSizeStore);
  return (
    <Box
      flexDirection="column"
      width={cols}
      height={rows}
      justifyContent={justifyContent}
      alignItems={alignItems}
      padding={padding}
    >
      {header}
      <Box
        flexDirection="column"
        flexGrow={1}
        minHeight={0}
        overflow="hidden"
        justifyContent={justifyContent}
        alignItems={alignItems}
      >
        {children}
      </Box>
      {footer !== undefined && footer !== null && (
        <Box flexDirection="column" flexShrink={0} width="100%">
          {footer}
        </Box>
      )}
    </Box>
  );
}
