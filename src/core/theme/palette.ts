export type ThemeColor = string | undefined;

export interface Theme {
  text: ThemeColor;
  textDim: ThemeColor;
  accent: ThemeColor;
  success: ThemeColor;
  error: ThemeColor;
  warning: ThemeColor;
  dimError: ThemeColor;
  dimSuccess: ThemeColor;
  info: ThemeColor;
  planner: ThemeColor;
  implementer: ThemeColor;
  reviewer: ThemeColor;
  validator: ThemeColor;
  border: ThemeColor;
  suggestionPanelBg: ThemeColor;
  selectionBg: ThemeColor;
  scrollIndicator: ThemeColor;
  diff: {
    added: ThemeColor;
    removed: ThemeColor;
    context: ThemeColor;
  };
  markdown: {
    heading: ThemeColor;
    bold: ThemeColor;
    italic: ThemeColor;
    code: ThemeColor;
    codeBg: ThemeColor;
    codeGutter: ThemeColor;
    blockquote: ThemeColor;
    list: ThemeColor;
    rule: ThemeColor;
    link: ThemeColor;
    strike: ThemeColor;
    tableBorder: ThemeColor;
  };
  syntax: {
    keyword: ThemeColor;
    string: ThemeColor;
    comment: ThemeColor;
    number: ThemeColor;
    literal: ThemeColor;
    type: ThemeColor;
    function: ThemeColor;
    punctuation: ThemeColor;
  };
  cursor: {
    fg: ThemeColor;
    bg: ThemeColor;
  };
  review: {
    file: ThemeColor;
  };
  highlight: {
    bg: ThemeColor;
    fg: ThemeColor;
  };
}

export const THEME_VARIANTS = ['dark', 'light'] as const;
export type ThemeVariant = (typeof THEME_VARIANTS)[number];

export type AnsiColor =
  | 'black'
  | 'red'
  | 'green'
  | 'yellow'
  | 'blue'
  | 'magenta'
  | 'cyan'
  | 'white'
  | 'gray'
  | 'redBright'
  | 'greenBright'
  | 'yellowBright'
  | 'blueBright'
  | 'magentaBright'
  | 'cyanBright'
  | 'whiteBright';

export interface Swatch {
  readonly truecolor: string;
  readonly ansi: AnsiColor | undefined;
}

export type ThemeSwatches = {
  readonly [Key in keyof Theme]: Theme[Key] extends ThemeColor
    ? Swatch
    : { readonly [Leaf in keyof Theme[Key]]: Swatch };
};

export interface Palette {
  readonly ground: string;
  readonly swatches: ThemeSwatches;
}

export const PALETTES: Readonly<Record<ThemeVariant, Palette>> = {
  dark: {
    ground: '#303446',
    swatches: {
      text: { truecolor: '#e6e9f2', ansi: undefined },
      textDim: { truecolor: '#b4bad0', ansi: 'white' },
      // Cyan belongs to paths and links; chrome uses blue.
      accent: { truecolor: '#8cb4ff', ansi: 'blueBright' },
      success: { truecolor: '#9fd88a', ansi: 'green' },
      error: { truecolor: '#ff8f9f', ansi: 'red' },
      warning: { truecolor: '#f0c674', ansi: 'yellow' },
      dimError: { truecolor: '#e5a3ad', ansi: 'red' },
      dimSuccess: { truecolor: '#b2d6a5', ansi: 'green' },
      // Info stays neutral; its label names its role.
      info: { truecolor: '#b4bad0', ansi: 'white' },
      planner: { truecolor: '#e0a8f0', ansi: 'magenta' },
      implementer: { truecolor: '#6aa8f7', ansi: 'blue' },
      // The review seat has its own hue, distinct from warning.
      reviewer: { truecolor: '#ffa95e', ansi: 'yellowBright' },
      // The validate label and stage glyphs carry the role and severity.
      validator: { truecolor: '#d4d8e4', ansi: 'white' },
      border: { truecolor: '#8a91ad', ansi: 'gray' },
      suggestionPanelBg: { truecolor: '#1f2233', ansi: undefined },
      selectionBg: { truecolor: '#363a4e', ansi: 'black' },
      scrollIndicator: { truecolor: '#b4bad0', ansi: 'white' },
      diff: {
        // Removed lines carry polarity, distinct from the error hue.
        added: { truecolor: '#8fe0a0', ansi: 'greenBright' },
        removed: { truecolor: '#ff8a5c', ansi: 'redBright' },
        context: { truecolor: '#b4bad0', ansi: 'white' },
      },
      markdown: {
        // Headings rank above body text through brightness and weight.
        heading: { truecolor: '#ffffff', ansi: 'whiteBright' },
        bold: { truecolor: '#e6e9f2', ansi: undefined },
        italic: { truecolor: '#b4bad0', ansi: 'white' },
        // Inline code stays distinct from warning yellow.
        code: { truecolor: '#f5a8e8', ansi: 'magentaBright' },
        codeBg: { truecolor: '#1f2233', ansi: undefined },
        codeGutter: { truecolor: '#8a91ad', ansi: 'gray' },
        blockquote: { truecolor: '#b4bad0', ansi: 'white' },
        list: { truecolor: '#b4bad0', ansi: 'white' },
        rule: { truecolor: '#8a91ad', ansi: 'gray' },
        link: { truecolor: '#7fd8e8', ansi: 'cyan' },
        strike: { truecolor: '#b4bad0', ansi: 'white' },
        tableBorder: { truecolor: '#8a91ad', ansi: 'gray' },
      },
      syntax: {
        keyword: { truecolor: '#e0a8f0', ansi: 'magenta' },
        string: { truecolor: '#9fd88a', ansi: 'green' },
        comment: { truecolor: '#b4bad0', ansi: 'white' },
        number: { truecolor: '#f0c674', ansi: 'yellow' },
        literal: { truecolor: '#f0c674', ansi: 'yellow' },
        type: { truecolor: '#7fd8e8', ansi: 'cyan' },
        function: { truecolor: '#6aa8f7', ansi: 'blue' },
        punctuation: { truecolor: '#b4bad0', ansi: 'white' },
      },
      cursor: {
        fg: { truecolor: '#1f2233', ansi: 'black' },
        bg: { truecolor: '#e6e9f2', ansi: 'white' },
      },
      review: {
        file: { truecolor: '#7fd8e8', ansi: 'cyan' },
      },
      highlight: {
        fg: { truecolor: '#e6e9f2', ansi: undefined },
        bg: { truecolor: '#363a4e', ansi: 'black' },
      },
    },
  },
  light: {
    ground: '#eceef2',
    swatches: {
      text: { truecolor: '#1f2328', ansi: undefined },
      textDim: { truecolor: '#454c59', ansi: undefined },
      accent: { truecolor: '#0b5bc8', ansi: 'blueBright' },
      success: { truecolor: '#116329', ansi: 'green' },
      error: { truecolor: '#a40e26', ansi: 'red' },
      warning: { truecolor: '#6b5900', ansi: 'yellow' },
      dimError: { truecolor: '#8a2f4f', ansi: 'red' },
      dimSuccess: { truecolor: '#2d5a3a', ansi: 'green' },
      info: { truecolor: '#454c59', ansi: undefined },
      planner: { truecolor: '#7a2fb8', ansi: 'magenta' },
      implementer: { truecolor: '#1d3c8f', ansi: 'blue' },
      reviewer: { truecolor: '#a34a00', ansi: 'yellowBright' },
      validator: { truecolor: '#2f353f', ansi: undefined },
      border: { truecolor: '#6b7181', ansi: 'gray' },
      suggestionPanelBg: { truecolor: '#f6f7f9', ansi: undefined },
      selectionBg: { truecolor: '#e1e4ea', ansi: 'white' },
      scrollIndicator: { truecolor: '#454c59', ansi: undefined },
      diff: {
        added: { truecolor: '#1a6b36', ansi: 'greenBright' },
        removed: { truecolor: '#86181d', ansi: 'redBright' },
        context: { truecolor: '#454c59', ansi: undefined },
      },
      markdown: {
        heading: { truecolor: '#000000', ansi: undefined },
        bold: { truecolor: '#1f2328', ansi: undefined },
        italic: { truecolor: '#454c59', ansi: undefined },
        code: { truecolor: '#8a1f6e', ansi: 'magentaBright' },
        codeBg: { truecolor: '#f6f7f9', ansi: undefined },
        codeGutter: { truecolor: '#6b7181', ansi: 'gray' },
        blockquote: { truecolor: '#454c59', ansi: undefined },
        list: { truecolor: '#454c59', ansi: undefined },
        rule: { truecolor: '#6b7181', ansi: 'gray' },
        link: { truecolor: '#0b5f6b', ansi: 'cyan' },
        strike: { truecolor: '#454c59', ansi: undefined },
        tableBorder: { truecolor: '#6b7181', ansi: 'gray' },
      },
      syntax: {
        keyword: { truecolor: '#7a2fb8', ansi: 'magenta' },
        string: { truecolor: '#116329', ansi: 'green' },
        comment: { truecolor: '#454c59', ansi: undefined },
        number: { truecolor: '#6b5900', ansi: 'yellow' },
        literal: { truecolor: '#6b5900', ansi: 'yellow' },
        type: { truecolor: '#0b5f6b', ansi: 'cyan' },
        function: { truecolor: '#1d3c8f', ansi: 'blue' },
        punctuation: { truecolor: '#454c59', ansi: undefined },
      },
      cursor: {
        fg: { truecolor: '#f6f7f9', ansi: 'white' },
        bg: { truecolor: '#1f2328', ansi: 'black' },
      },
      review: {
        file: { truecolor: '#0b5f6b', ansi: 'cyan' },
      },
      highlight: {
        fg: { truecolor: '#1f2328', ansi: undefined },
        bg: { truecolor: '#e1e4ea', ansi: 'white' },
      },
    },
  },
};

export type TokenRole = 'text' | 'mark' | 'surface' | 'cursor-text';

export function themeTokenRole(path: string): TokenRole {
  switch (path) {
    case 'suggestionPanelBg':
    case 'selectionBg':
    case 'markdown.codeBg':
    case 'highlight.bg':
      return 'surface';
    case 'border':
    case 'markdown.rule':
    case 'markdown.tableBorder':
    case 'markdown.codeGutter':
    case 'cursor.bg':
      return 'mark';
    case 'cursor.fg':
      return 'cursor-text';
    default:
      return 'text';
  }
}
