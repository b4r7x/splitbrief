import type { ReactNode } from 'react';
import { resolveTheme, ThemeProvider } from '../components/theme.js';

export function AppProvider({ children }: { children: ReactNode }) {
  return <ThemeProvider theme={resolveTheme()}>{children}</ThemeProvider>;
}
