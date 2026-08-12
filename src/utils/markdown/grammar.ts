export interface MarkdownFenceStart {
  marker: string;
  language: string | undefined;
}

export interface MarkdownHeadingStart {
  marker: string;
  text: string;
}

export interface MarkdownSetextHeadingStart {
  marker: '=' | '-';
  text: string;
}

export const REQUIRED_TASK_BRIEF_METADATA_KEYS = [
  'id',
  'title',
  'action',
  'file',
  'depends_on',
] as const;

export const TASK_BRIEF_METADATA_KEYS: ReadonlySet<string> = new Set(
  REQUIRED_TASK_BRIEF_METADATA_KEYS,
);

export function parseMarkdownFenceStart(line: string): MarkdownFenceStart | undefined {
  const start = parseFenceStart(line);
  if (start === undefined) return undefined;

  const info = start.trimmed.slice(start.marker.length).trim();
  const languageMatch = /^\S+/.exec(info);
  return { marker: start.marker, language: languageMatch?.[0] };
}

export function markdownFenceMarker(line: string): string | undefined {
  return parseFenceStart(line)?.marker;
}

export function isMarkdownFenceStartLine(line: string): boolean {
  return markdownFenceMarker(line) !== undefined;
}

export function isMarkdownFenceCloseLine(line: string, marker: string): boolean {
  const trimmed = trimFenceIndent(line);
  if (trimmed === undefined) return false;

  const first = marker[0];
  if (first !== '`' && first !== '~') return false;

  const count = countLeading(trimmed, first);
  if (count < marker.length) return false;
  return trimmed.slice(count).trim().length === 0;
}

export function parseMarkdownHeadingStart(line: string): MarkdownHeadingStart | undefined {
  const match = /^ {0,3}(#{1,6})(?:[ \t]+(.*?)[ \t]*)?$/.exec(line);
  const marker = match?.[1];
  if (marker === undefined) return undefined;

  const rawText = match?.[2] ?? '';
  const text = rawText.replace(/[ \t]+#+[ \t]*$/, '').trim();
  return { marker, text };
}

export function isMarkdownHeadingLine(line: string): boolean {
  return parseMarkdownHeadingStart(line) !== undefined;
}

export function parseMarkdownSetextHeadingStart(
  line: string,
  nextLine: string | undefined,
): MarkdownSetextHeadingStart | undefined {
  if (!/^ {0,3}\S/.test(line)) return undefined;
  if (!isMarkdownSetextUnderlineLine(nextLine ?? '')) return undefined;
  if (startsMarkdownBlockLine(line, nextLine)) return undefined;

  const marker = nextLine?.trimStart()[0];
  if (marker !== '=' && marker !== '-') return undefined;
  return { marker, text: line.trim() };
}

export function isMarkdownSetextHeadingLine(line: string, nextLine: string | undefined): boolean {
  return parseMarkdownSetextHeadingStart(line, nextLine) !== undefined;
}

export function isMarkdownSetextUnderlineLine(line: string): boolean {
  return /^ {0,3}(=+|-+)[ \t]*$/.test(line);
}

export function isMarkdownThematicBreakLine(line: string): boolean {
  return /^ {0,3}((?:-\s*){3,}|(?:_\s*){3,}|(?:\*\s*){3,})$/.test(line);
}

export function isMarkdownListItemLine(line: string): boolean {
  return /^(\s*)([-*+])\s+.+$/.test(line) || /^(\s*)(\d+)([.)])\s+.+$/.test(line);
}

export function isMarkdownBlockquoteLine(line: string): boolean {
  return /^ {0,3}>\s?.*$/.test(line);
}

export function startsMarkdownBlockLine(line: string, nextLine: string | undefined): boolean {
  return (
    isMarkdownFenceStartLine(line) ||
    isMarkdownHeadingLine(line) ||
    isMarkdownThematicBreakLine(line) ||
    isMarkdownListItemLine(line) ||
    isMarkdownBlockquoteLine(line) ||
    (isMarkdownTableLine(line) && isMarkdownTableSeparatorLine(nextLine ?? '')) ||
    isMarkdownHtmlCommentStartLine(line)
  );
}

// An indented, non-blank line under a list item continues that item's paragraph. The block
// parser folds it into the item and the transcript chunker keeps it in the same chunk, so
// both paths bind it to the bullet it belongs to instead of to the bullet that follows.
export function isMarkdownListContinuationLine(
  line: string,
  nextLine: string | undefined,
): boolean {
  if (!/^\s/.test(line) || line.trim().length === 0) return false;
  return !startsMarkdownBlockLine(line, nextLine);
}

export function isMarkdownTableLine(line: string): boolean {
  return line.trimStart().startsWith('|');
}

export function isMarkdownTableSeparatorLine(line: string): boolean {
  return /^\s*\|(?:\s*:?-+:?\s*\|)+\s*$/.test(line);
}

export function isMarkdownHtmlCommentStartLine(line: string): boolean {
  return line.trimStart().startsWith('<!--');
}

export function markdownHtmlCommentEndsOnLine(line: string): boolean {
  return line.includes('-->');
}

export function isMarkdownYamlLikeLine(line: string): boolean {
  return parseMarkdownYamlKey(line) !== undefined || isMarkdownYamlContinuationLine(line);
}

export function parseMarkdownYamlKey(line: string): string | undefined {
  const match = /^([A-Za-z0-9_-]+):\s*.*$/.exec(line);
  return match?.[1];
}

export function isMarkdownYamlContinuationLine(line: string): boolean {
  return line.trim() !== '---' && !isMarkdownSetextUnderlineLine(line) && /^\s{2,}\S.*$/.test(line);
}

export function hasTaskBriefMetadataKeys(keys: ReadonlySet<string>): boolean {
  for (const key of keys) {
    if (!TASK_BRIEF_METADATA_KEYS.has(key)) return false;
  }

  for (const key of REQUIRED_TASK_BRIEF_METADATA_KEYS) {
    if (!keys.has(key)) return false;
  }

  return true;
}

function markdownFenceMarkerFromTrimmed(trimmed: string): string | undefined {
  const first = trimmed[0];
  if (first !== '`' && first !== '~') return undefined;

  const count = countLeading(trimmed, first);
  if (count < 3) return undefined;
  return first.repeat(count);
}

function parseFenceStart(line: string): { trimmed: string; marker: string } | undefined {
  const trimmed = trimFenceIndent(line);
  if (trimmed === undefined) return undefined;

  const marker = markdownFenceMarkerFromTrimmed(trimmed);
  if (marker === undefined) return undefined;

  const info = trimmed.slice(marker.length).trim();
  if (marker[0] === '`' && info.includes('`')) return undefined;
  return { trimmed, marker };
}

function trimFenceIndent(line: string): string | undefined {
  const match = /^( {0,3})(.*)$/.exec(line);
  return match?.[2];
}

function countLeading(text: string, char: string): number {
  let count = 0;
  while (text[count] === char) count += 1;
  return count;
}
