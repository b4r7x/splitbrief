import type { ReactNode } from 'react';
import { ThemeProvider } from '../components/theme.js';
import { themeForTerminal } from '../core/theme/resolve.js';
import { terminalBackgroundStore } from '../stores/ui/terminal-background.js';

export function AppProvider({ children }: { children: ReactNode }) {
  const terminalBackground = terminalBackgroundStore.use((s) => s);
  return <ThemeProvider theme={themeForTerminal(terminalBackground)}>{children}</ThemeProvider>;
}
