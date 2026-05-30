import {
  NATURAL_LANGUAGE_PREFIXES,
  CODE_LINE_STARTS,
  CODE_LINE_CHARS,
  TS_IMPORT_EXPORT_RE,
  TS_KEYWORDS_RE,
  SEMICOLON_RE,
  OPEN_BRACE_RE,
  CLOSE_BRACE_RE,
} from './code-patterns.js';

export function isCodeLine(line: string): boolean {
  const trimmed = line.trimStart();
  if (trimmed === '') return true;

  for (const start of CODE_LINE_STARTS) {
    if (trimmed.startsWith(start)) return true;
  }

  for (const char of CODE_LINE_CHARS) {
    if (trimmed.startsWith(char)) return true;
  }

  return false;
}

export function looksLikeTypeScript(text: string): boolean {
  const hasImportOrExport = TS_IMPORT_EXPORT_RE.test(text);
  const hasTypeKeywords = TS_KEYWORDS_RE.test(text);
  const semicolons = (text.match(SEMICOLON_RE) || []).length;
  const openBraces = (text.match(OPEN_BRACE_RE) || []).length;
  const closeBraces = (text.match(CLOSE_BRACE_RE) || []).length;

  const indicators = [
    hasImportOrExport,
    hasTypeKeywords,
    semicolons >= 2,
    openBraces >= 1 && closeBraces >= 1,
    Math.abs(openBraces - closeBraces) <= 2,
  ];

  const score = indicators.filter(Boolean).length;
  return score >= 3;
}

function isNaturalLanguageLine(line: string): boolean {
  const trimmed = line.trimStart();
  if (trimmed === '') return false;
  return NATURAL_LANGUAGE_PREFIXES.some((prefix) => trimmed.startsWith(prefix));
}

export function stripNaturalLanguage(text: string): string {
  const lines = text.split('\n');

  let start = 0;
  while (start < lines.length) {
    const line = lines[start] ?? '';
    if (!isNaturalLanguageLine(line) && line.trim() !== '') break;
    start++;
  }

  let end = lines.length - 1;
  while (end > start) {
    const line = lines[end] ?? '';
    if (!isNaturalLanguageLine(line) && line.trim() !== '') break;
    end--;
  }

  if (start > end) return '';
  return lines
    .slice(start, end + 1)
    .join('\n')
    .trim();
}
