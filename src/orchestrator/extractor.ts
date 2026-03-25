const NATURAL_LANGUAGE_PREFIXES = [
  'Here',
  "I'll",
  'This ',
  'The ',
  'Let me',
  'Sure',
  'Note:',
  'Below',
  'Above',
  'In this',
  'As you',
  'You can',
  'We ',
  'Now ',
  'First',
  'Finally',
  'Great',
  'Okay',
  'Of course',
];

const CODE_LINE_STARTS = [
  'import ',
  'export ',
  'const ',
  'let ',
  'function ',
  'type ',
  'interface ',
  'class ',
  'if ',
  'if(',
  'for ',
  'for(',
  'while ',
  'while(',
  'return ',
  'return;',
  'throw ',
  'try ',
  'try{',
  'catch ',
  'catch(',
  'async ',
  'await ',
  'switch ',
  'switch(',
  'default:',
  'case ',
];

const CODE_LINE_CHARS = ['{', '}', ')', ';', '//', '/*', ' *', '*/'];

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
  const hasImportOrExport = /\b(import|export)\b/.test(text);
  const hasTypeKeywords = /\b(interface|type|const|function|async|await)\b/.test(text);
  const semicolons = (text.match(/;/g) || []).length;
  const openBraces = (text.match(/{/g) || []).length;
  const closeBraces = (text.match(/}/g) || []).length;

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

export function stripMarkdownFences(text: string): string {
  return text
    .replace(/^```(?:typescript|ts)?\s*\n/gm, '')
    .replace(/^```\s*$/gm, '')
    .trim();
}

function extractFencedBlocks(response: string): string[] {
  const blocks: string[] = [];
  const regex = /```(?:typescript|ts)?\s*\n([\s\S]*?)```/g;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(response)) !== null) {
    blocks.push(match[1].trim());
  }
  return blocks;
}

function isNaturalLanguageLine(line: string): boolean {
  const trimmed = line.trimStart();
  if (trimmed === '') return false;
  return NATURAL_LANGUAGE_PREFIXES.some((prefix) => trimmed.startsWith(prefix));
}

function stripNaturalLanguage(text: string): string {
  const lines = text.split('\n');

  let start = 0;
  while (start < lines.length && (isNaturalLanguageLine(lines[start]) || lines[start].trim() === '')) {
    start++;
  }

  let end = lines.length - 1;
  while (end > start && (isNaturalLanguageLine(lines[end]) || lines[end].trim() === '')) {
    end--;
  }

  if (start > end) return '';
  return lines.slice(start, end + 1).join('\n').trim();
}

type ExtractionResult =
  | { code: string; confidence: 'high' | 'medium' | 'low' }
  | { error: string };

export function extractCode(response: string): ExtractionResult {
  const trimmed = response.trim();
  if (!trimmed) return { error: 'Could not extract code from response' };

  // Strategy A: fenced code blocks
  const blocks = extractFencedBlocks(trimmed);
  if (blocks.length > 0) {
    const longest = blocks.reduce((a, b) => (a.length >= b.length ? a : b));
    return { code: longest, confidence: 'high' };
  }

  // Strategy B: response looks like raw code
  if (/^(import |export |\/\/|\/\*)/.test(trimmed)) {
    return { code: trimmed, confidence: 'high' };
  }

  const lines = trimmed.split('\n');
  const nonEmpty = lines.filter((l) => l.trim() !== '');
  if (nonEmpty.length > 0 && nonEmpty.every((l) => isCodeLine(l))) {
    return { code: trimmed, confidence: 'high' };
  }

  // Strategy C: strip natural language from edges
  const stripped = stripNaturalLanguage(trimmed);
  if (stripped && looksLikeTypeScript(stripped)) {
    return { code: stripMarkdownFences(stripped), confidence: 'medium' };
  }

  return { error: 'Could not extract code from response' };
}
