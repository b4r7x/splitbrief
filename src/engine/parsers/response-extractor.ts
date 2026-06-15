import { isCodeLine, looksLikeTypeScript, stripNaturalLanguage } from './code-detection.js';
import { extractFencedBlocks, hasCodePrefix, stripMarkdownFences } from './code-patterns.js';

export type ExtractedCode = { code: string };

export type ExtractionResult = ExtractedCode | { error: string };

export function extractCode(response: string): ExtractionResult {
  const trimmed = response.trim();
  if (!trimmed) return { error: 'Could not extract code from response' };

  const blocks = extractFencedBlocks(trimmed);
  if (blocks.length > 0) {
    const markerBlocks = blocks.filter((b) => b.includes('<<<<<<< SEARCH'));
    if (markerBlocks.length > 0) {
      return { code: markerBlocks.join('\n') };
    }
    const longest = blocks.reduce((a, b) => (a.length >= b.length ? a : b));
    return { code: longest };
  }

  if (hasCodePrefix(trimmed)) {
    return { code: trimmed };
  }

  const lines = trimmed.split('\n');
  const nonEmpty = lines.filter((l) => l.trim() !== '');
  if (nonEmpty.length > 0 && nonEmpty.every((l) => isCodeLine(l))) {
    return { code: trimmed };
  }

  const stripped = stripNaturalLanguage(trimmed);
  if (stripped && looksLikeTypeScript(stripped)) {
    return { code: stripMarkdownFences(stripped) };
  }

  return { error: 'Could not extract code from response' };
}
