import type { ReactNode } from 'react';
import { getTheme, ThemeProvider } from '../components/theme.js';
import { configStore } from '../stores/project/config.js';

export function AppProvider({ children }: { children: ReactNode }) {
  const config = configStore.useConfig();
  return <ThemeProvider theme={getTheme(config.theme)}>{children}</ThemeProvider>;
}
