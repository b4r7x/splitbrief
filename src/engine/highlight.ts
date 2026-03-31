import { createHighlighterCore } from 'shiki/core';
import { createJavaScriptRegexEngine } from 'shiki/engine/javascript';
import type { HighlighterCore } from 'shiki/core';
import ansis from 'ansis';

let highlighter: HighlighterCore | null = null;
let currentThemeName = 'github-dark';
const cache = new Map<string, string>();

async function getHighlighter(): Promise<HighlighterCore> {
  if (!highlighter) {
    highlighter = await createHighlighterCore({
      themes: [
        import('@shikijs/themes/github-dark'),
        import('@shikijs/themes/github-light'),
      ],
      langs: [
        import('@shikijs/langs/typescript'),
        import('@shikijs/langs/javascript'),
      ],
      engine: createJavaScriptRegexEngine(),
    });
  }
  return highlighter;
}

export function setShikiTheme(name: string): void {
  if (name !== currentThemeName) {
    currentThemeName = name;
    cache.clear();
  }
}

export async function highlight(code: string, lang: 'typescript' | 'javascript' = 'typescript'): Promise<string> {
  const key = `${lang}:${currentThemeName}:${code}`;
  const cached = cache.get(key);
  if (cached) return cached;

  try {
    const h = await getHighlighter();
    const tokens = h.codeToTokensBase(code, { lang, theme: currentThemeName });
    const themeReg = h.getTheme(currentThemeName);

    let output = '';
    for (const line of tokens) {
      for (const token of line) {
        let text = token.content;
        const color = token.color || themeReg.fg;
        if (color) text = ansis.hex(color)(text);
        if (token.fontStyle) {
          if (token.fontStyle & 1) text = ansis.italic(text);
          if (token.fontStyle & 2) text = ansis.bold(text);
          if (token.fontStyle & 4) text = ansis.underline(text);
        }
        output += text;
      }
      output += '\n';
    }

    cache.set(key, output);
    return output;
  } catch {
    return code;
  }
}
