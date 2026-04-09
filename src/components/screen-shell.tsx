import type { ReactNode } from 'react';
import { Box } from 'ink';
import { terminalSizeStore } from '../stores/terminal-size.js';

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
  const cols = terminalSizeStore.use(s => s.cols);
  const rows = terminalSizeStore.use(s => s.rows);
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
      <Box flexDirection="column" flexGrow={1} justifyContent={justifyContent} alignItems={alignItems}>{children}</Box>
      {footer}
    </Box>
  );
}
