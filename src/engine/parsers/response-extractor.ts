import { isCodeLine, looksLikeTypeScript, stripNaturalLanguage } from './code-detection.js';

export function stripMarkdownFences(text: string): string {
  return text
    .replace(/^```(?:typescript|ts)?\s*\n/gm, '')
    .replace(/^```\s*$/gm, '')
    .trim();
}

function extractFencedBlocks(response: string): string[] {
  const blocks: string[] = [];
  const regex = /```(?:typescript|ts)?\s*\n([\s\S]*?)```/g;
  for (let match = regex.exec(response); match !== null; match = regex.exec(response)) {
    if (match[1] !== undefined) blocks.push(match[1].trim());
  }
  return blocks;
}

export type ExtractionResult =
  | { code: string; confidence: 'high' | 'medium' | 'low' }
  | { error: string };

export function extractCode(response: string): ExtractionResult {
  const trimmed = response.trim();
  if (!trimmed) return { error: 'Could not extract code from response' };

  const blocks = extractFencedBlocks(trimmed);
  if (blocks.length > 0) {
    const longest = blocks.reduce((a, b) => (a.length >= b.length ? a : b));
    return { code: longest, confidence: 'high' };
  }

  if (/^(import |export |\/\/|\/\*)/.test(trimmed)) {
    return { code: trimmed, confidence: 'high' };
  }

  const lines = trimmed.split('\n');
  const nonEmpty = lines.filter((l) => l.trim() !== '');
  if (nonEmpty.length > 0 && nonEmpty.every((l) => isCodeLine(l))) {
    return { code: trimmed, confidence: 'high' };
  }

  const stripped = stripNaturalLanguage(trimmed);
  if (stripped && looksLikeTypeScript(stripped)) {
    return { code: stripMarkdownFences(stripped), confidence: 'medium' };
  }

  return { error: 'Could not extract code from response' };
}
