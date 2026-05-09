import { createContext, useContext } from 'react';

export interface ThemeColors {
  text: string;
  textDim: string;
  accent: string;
  success: string;
  error: string;
  warning: string;
  info: string;
}

export interface Theme {
  text: string;
  textDim: string;
  accent: string;
  success: string;
  error: string;
  warning: string;
  info: string;
  planner: string;
  implementer: string;
  validator: string;
  border: string;
  panelBg: string | undefined;
  suggestionPanelBg: string;
  selectionBg: string;
  spinner: string;
  scrollIndicator: string;
  diff: {
    added: string;
    addedBg: string | undefined;
    removed: string;
    removedBg: string | undefined;
    context: string;
    contextBg: string | undefined;
  };
  markdown: {
    heading: string;
    bold: string;
    italic: string;
    code: string;
  };
  cursor: {
    fg: string;
    bg: string;
  };
  review: {
    file: string;
  };
  highlight: {
    bg: string;
    fg: string;
  };
}

const terminalTheme: Theme = {
  text: 'white',
  textDim: 'gray',
  accent: 'cyan',
  success: 'green',
  error: 'red',
  warning: 'yellow',
  info: 'blue',
  planner: 'magenta',
  implementer: 'cyan',
  validator: 'green',
  border: 'gray',
  panelBg: undefined,
  suggestionPanelBg: '#24283b',
  selectionBg: '#333333',
  spinner: 'cyan',
  scrollIndicator: 'gray',
  diff: {
    added: 'green',
    addedBg: undefined,
    removed: 'red',
    removedBg: undefined,
    context: 'gray',
    contextBg: undefined,
  },
  markdown: {
    heading: 'cyan',
    bold: 'white',
    italic: 'gray',
    code: 'yellow',
  },
  cursor: {
    fg: 'black',
    bg: 'white',
  },
  review: {
    file: 'white',
  },
  highlight: {
    bg: '#333333',
    fg: 'white',
  },
};

const monoTheme: Theme = {
  text: '#c0c0c0',
  textDim: '#666666',
  accent: '#7aa2f7',
  success: '#9ece6a',
  error: '#f7768e',
  warning: '#e0af68',
  info: '#7dcfff',
  planner: '#bb9af7',
  implementer: '#7dcfff',
  validator: '#9ece6a',
  border: '#3b3b3b',
  panelBg: '#1a1a1a',
  suggestionPanelBg: '#1a1a1a',
  selectionBg: '#2a2a3a',
  spinner: '#7aa2f7',
  scrollIndicator: '#666666',
  diff: {
    added: '#4fd6be',
    addedBg: '#20303b',
    removed: '#c53b53',
    removedBg: '#37222c',
    context: '#828bb8',
    contextBg: '#141414',
  },
  markdown: {
    heading: '#7aa2f7',
    bold: '#c0c0c0',
    italic: '#828bb8',
    code: '#e0af68',
  },
  cursor: {
    fg: '#1a1a1a',
    bg: '#c0c0c0',
  },
  review: {
    file: '#c0c0c0',
  },
  highlight: {
    bg: '#2a2a3a',
    fg: '#c0c0c0',
  },
};

export function getTheme(mode: 'terminal' | 'mono' = 'terminal'): Theme {
  return mode === 'mono' ? monoTheme : terminalTheme;
}

const ThemeContext = createContext<Theme>(terminalTheme);

export function ThemeProvider({
  theme = terminalTheme,
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
