import type { ReactNode } from 'react';
import { resolveTheme, ThemeProvider } from '../components/theme.js';
import { configStore } from '../stores/project/config.js';

export function AppProvider({ children }: { children: ReactNode }) {
  const config = configStore.useConfig();
  return <ThemeProvider theme={resolveTheme(config.theme)}>{children}</ThemeProvider>;
}
