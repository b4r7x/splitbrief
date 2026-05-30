import { isCodeLine, looksLikeTypeScript, stripNaturalLanguage } from './code-detection.js';
import { extractFencedBlocks, hasCodePrefix, stripMarkdownFences } from './code-patterns.js';

export type ExtractedCode = { code: string; confidence: 'high' | 'medium' | 'low' };

export type ExtractionResult = ExtractedCode | { error: string };

export function extractCode(response: string): ExtractionResult {
  const trimmed = response.trim();
  if (!trimmed) return { error: 'Could not extract code from response' };

  const blocks = extractFencedBlocks(trimmed);
  if (blocks.length > 0) {
    const longest = blocks.reduce((a, b) => (a.length >= b.length ? a : b));
    return { code: longest, confidence: 'high' };
  }

  if (hasCodePrefix(trimmed)) {
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
