import { createContext, useContext } from 'react';

export interface Theme {
  text: string;
  textDim: string;
  accent: string;
  success: string;
  error: string;
  warning: string;
  dimError: string;
  dimSuccess: string;
  info: string;
  planner: string;
  implementer: string;
  reviewer: string;
  validator: string;
  border: string;
  panelBg: string | undefined;
  suggestionPanelBg: string;
  selectionBg: string;
  scrollIndicator: string;
  diff: {
    added: string;
    removed: string;
    context: string;
  };
  markdown: {
    heading: string;
    bold: string;
    italic: string;
    code: string;
    codeBg: string | undefined;
    codeGutter: string;
    blockquote: string;
    list: string;
    rule: string;
    link: string;
    strike: string;
    tableBorder: string;
  };
  syntax: {
    keyword: string;
    string: string;
    comment: string;
    number: string;
    literal: string;
    type: string;
    function: string;
    punctuation: string;
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

export const terminalTheme: Theme = {
  text: 'white',
  textDim: 'gray',
  // Cyan is the link, and nothing else on a document or chrome surface may take it.
  accent: 'blueBright',
  success: 'green',
  error: 'red',
  warning: 'yellow',
  dimError: 'red', // 16-color named ANSI collapses dim to base error/success.
  dimSuccess: 'green',
  // Five tokens co-occur in the activity label column — accent, planner, info, implementer,
  // reviewer. Of the three brights this palette leaves unspent, blackBright is gray under
  // another name and cyanBright steps off the link reservation above; yellowBright steps off
  // warning, and a severity never labels a seat, so the seat cannot be read as one. info drops
  // the hue instead: its label is a word in a column of words and carries the distinction
  // itself, as validator does below.
  info: 'gray',
  planner: 'magenta',
  implementer: 'blue',
  reviewer: 'yellowBright',
  // A role the reader never infers from color: validator output arrives inside a block the word
  // `validate` already names, with per-stage glyphs carrying severity.
  validator: 'white',
  border: 'gray',
  panelBg: undefined,
  suggestionPanelBg: '#24283b',
  selectionBg: '#333333',
  scrollIndicator: 'gray',
  diff: {
    // Polarity, not severity: a removed line inside an error block must not wear the error hue.
    added: 'greenBright',
    removed: 'redBright',
    context: 'gray',
  },
  markdown: {
    // Cyan belongs to paths and links here, so the heading ranks step down on brightness and
    // weight instead of spending the one hue a reader uses to spot something clickable. That
    // needs heading to sit a step above body text, or depth 3 renders as an ordinary sentence.
    heading: 'whiteBright',
    bold: 'white',
    italic: 'gray',
    // Not yellow: warning is yellow here, and inline code appears in ordinary prose, where a
    // yellow run reads as a severity.
    code: 'magentaBright',
    codeBg: '#24283b',
    codeGutter: '#6272a4',
    blockquote: 'gray',
    list: 'gray',
    rule: 'gray',
    link: 'cyan',
    strike: 'gray',
    tableBorder: 'gray',
  },
  syntax: {
    keyword: 'magenta',
    string: 'green',
    comment: 'gray',
    number: 'yellow',
    literal: 'yellow',
    type: 'cyan',
    function: 'blue',
    punctuation: 'gray',
  },
  cursor: {
    fg: 'black',
    bg: 'white',
  },
  review: {
    file: 'cyan', // a file path that is also a link takes the link tone
  },
  highlight: {
    bg: '#333333',
    fg: 'white',
  },
};

// What the code frame becomes once chalk downsamples it to the 16-color set (ansi-styles
// rgbToAnsi): #24283b lands on bgBlack, which on a dark profile is the terminal's own ground,
// so the painted block stops framing anything; #6272a4 lands on blue, the same bucket the
// terminal preset already spends on syntax.function, so the rail takes the color of the code it
// encloses. No named background frames without shouting, so at 16 colors the rail, the padding
// and the right-flush language tag carry the frame on their own.
export const ansiTerminalTheme: Theme = {
  ...terminalTheme,
  markdown: { ...terminalTheme.markdown, codeBg: undefined, codeGutter: 'gray' },
};

export function getTheme(): Theme {
  return terminalTheme;
}

// Only offer hi-color when the terminal advertises hi-color support;
// otherwise fall back to the named-ANSI preset, which stays legible everywhere.
export function supportsHexColors(env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.NO_COLOR !== undefined && env.NO_COLOR !== '') return false;
  const colorterm = env.COLORTERM?.toLowerCase() ?? '';
  if (colorterm === 'truecolor' || colorterm === '24bit') return true;
  return /256/.test(env.TERM ?? '');
}

export function resolveTheme(env?: NodeJS.ProcessEnv): Theme {
  if (!supportsHexColors(env)) return ansiTerminalTheme;
  return terminalTheme;
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
