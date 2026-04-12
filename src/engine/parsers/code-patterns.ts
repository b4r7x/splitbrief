export const NATURAL_LANGUAGE_PREFIXES = [
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

export const CODE_LINE_STARTS = [
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

export const CODE_LINE_CHARS = ['{', '}', ')', ';', '//', '/*', ' *', '*/'];

const FENCED_BLOCK_WITH_LANG_PATTERN = '```[\\w]*\\s*\\n([\\s\\S]*?)```';
const FENCED_ANY_BLOCK_RE = /```[\w]*\n([\s\S]*?)```/;
const FENCE_OPEN_LINE_RE = /^```[\w]*\s*\n/gm;
const FENCE_CLOSE_LINE_RE = /^```\s*$/gm;
const CODE_PREFIX_RE = /^(import |export |\/\/|\/\*)/;

export const EXPORT_BOUNDARY_RE =
  /^export\s+(default\s+(function|class)|async\s+function|function|const|interface|type|class)\b/;

export const EXPORT_NAME_PATTERNS: readonly { re: RegExp }[] = [
  { re: /^export\s+(?:async\s+)?function\s+(\w+)/ },
  { re: /^export\s+const\s+(\w+)/ },
  { re: /^export\s+interface\s+(\w+)/ },
  { re: /^export\s+type\s+(\w+)/ },
  { re: /^export\s+class\s+(\w+)/ },
];

export const EXPORT_DEFAULT_NAME_RE = /^export\s+default\s+(?:function|class)\s+(\w+)/;

export const TS_IMPORT_EXPORT_RE = /\b(import|export)\b/;
export const TS_KEYWORDS_RE = /\b(interface|type|const|function|async|await)\b/;
export const SEMICOLON_RE = /;/g;
export const OPEN_BRACE_RE = /{/g;
export const CLOSE_BRACE_RE = /}/g;

export const DECLARATION_NAME_RE = /(?:function|const|class|interface|type)\s+(\w+)/;

export function extractFencedBlocks(text: string): string[] {
  const blocks: string[] = [];
  const re = new RegExp(FENCED_BLOCK_WITH_LANG_PATTERN, 'g');
  for (let match = re.exec(text); match !== null; match = re.exec(text)) {
    if (match[1] !== undefined) blocks.push(match[1].trim());
  }
  return blocks;
}

export function stripMarkdownFences(text: string): string {
  return text
    .replace(FENCE_OPEN_LINE_RE, '')
    .replace(FENCE_CLOSE_LINE_RE, '')
    .trim();
}

export function hasCodePrefix(line: string): boolean {
  return CODE_PREFIX_RE.test(line);
}

export function extractFirstFencedBlock(text: string): string | null {
  const match = text.match(FENCED_ANY_BLOCK_RE);
  return match?.[1] !== undefined ? match[1].trim() : null;
}
