import { createContext, useContext } from 'react';

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
    blockquote: string;
    list: string;
    rule: string;
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
    blockquote: 'gray',
    list: 'cyan',
    rule: 'gray',
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
    blockquote: '#828bb8',
    list: '#7aa2f7',
    rule: '#3b3b3b',
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

// The mono preset is truecolor/256 hex. On a 16-color terminal those hexes are downsampled to the
// nearest ANSI bucket, where slate textDim (#666) and accent (#7aa2f7) can collapse together and
// break the dim-vs-accent separation. Only offer it when the terminal advertises hi-color support;
// otherwise fall back to the named-ANSI preset, which stays legible everywhere.
export function supportsHexColors(env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.NO_COLOR !== undefined && env.NO_COLOR !== '') return false;
  const colorterm = env.COLORTERM?.toLowerCase() ?? '';
  if (colorterm === 'truecolor' || colorterm === '24bit') return true;
  return /256/.test(env.TERM ?? '');
}

export function resolveTheme(
  mode: 'terminal' | 'mono' = 'terminal',
  env?: NodeJS.ProcessEnv,
): Theme {
  if (mode === 'mono' && !supportsHexColors(env)) return terminalTheme;
  return getTheme(mode);
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
