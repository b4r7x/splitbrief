export interface MarkdownFenceStart {
  marker: string;
  language: string | undefined;
}

export interface MarkdownHeadingStart {
  marker: string;
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
  const trimmed = trimFenceIndent(line);
  if (trimmed === undefined) return undefined;

  const marker = markdownFenceMarkerFromTrimmed(trimmed);
  if (!marker) return undefined;

  const info = trimmed.slice(marker.length).trim();
  const languageMatch = /^\S+/.exec(info);
  return { marker, language: languageMatch?.[0] };
}

export function markdownFenceMarker(line: string): string | undefined {
  const trimmed = trimFenceIndent(line);
  return trimmed === undefined ? undefined : markdownFenceMarkerFromTrimmed(trimmed);
}

export function isMarkdownFenceStartLine(line: string): boolean {
  return markdownFenceMarker(line) !== undefined;
}

export function isMarkdownFenceCloseLine(line: string, marker: string): boolean {
  const trimmed = trimFenceIndent(line);
  if (trimmed === undefined) return false;

  const first = marker[0];
  if (first === undefined) return false;

  const count = countLeading(trimmed, first);
  if (count < marker.length) return false;
  return trimmed.slice(count).trim().length === 0;
}

export function parseMarkdownHeadingStart(line: string): MarkdownHeadingStart | undefined {
  const match = /^(#{1,6})\s+(.+?)\s*$/.exec(line);
  const marker = match?.[1];
  const text = match?.[2];
  return marker && text ? { marker, text } : undefined;
}

export function isMarkdownHeadingLine(line: string): boolean {
  return parseMarkdownHeadingStart(line) !== undefined;
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
  return /^\s{2,}\S.*$/.test(line);
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

function trimFenceIndent(line: string): string | undefined {
  const trimmed = line.trimStart();
  if (line.length - trimmed.length > 3) return undefined;
  return trimmed;
}

function countLeading(text: string, char: string): number {
  let count = 0;
  while (text[count] === char) count += 1;
  return count;
}
