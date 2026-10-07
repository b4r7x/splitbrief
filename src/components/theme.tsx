import { Text } from 'ink';
import { createContext, useContext, type ComponentProps } from 'react';

import type { Theme, ThemeColor } from '../core/theme/palette.js';
import { resolveTheme } from '../core/theme/resolve.js';

export const defaultTheme = resolveTheme({
  variant: 'dark',
  level: 3,
  terminalBackground: undefined,
});

const ThemeContext = createContext<Theme>(defaultTheme);

export function ThemeProvider({
  theme = defaultTheme,
  children,
}: {
  theme?: Theme;
  children: React.ReactNode;
}) {
  return <ThemeContext.Provider value={theme}>{children}</ThemeContext.Provider>;
}

export function useTheme(): Theme {
  return useContext(ThemeContext);
}

export function ThemeText({
  color,
  backgroundColor,
  ...props
}: Omit<ComponentProps<typeof Text>, 'color' | 'backgroundColor'> & {
  color?: ThemeColor;
  backgroundColor?: ThemeColor;
}) {
  return (
    <Text
      {...props}
      {...(color === undefined ? {} : { color })}
      {...(backgroundColor === undefined ? {} : { backgroundColor })}
    />
  );
}
