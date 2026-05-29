import type { ParsedLine } from '../runners/types.js';

export function parseTextLine(line: string): ParsedLine {
  if (!line.trim()) return {};

  const tokenMatch = line.match(/Tokens:\s*([\d.]+k?)\s*sent,\s*([\d.]+k?)\s*received/i);
  if (tokenMatch?.[1] && tokenMatch[2]) {
    const parseK = (v: string) => {
      const n = parseFloat(v);
      return v.toLowerCase().endsWith('k') ? Math.round(n * 1000) : Math.round(n);
    };
    return { usage: { inputTokens: parseK(tokenMatch[1]), outputTokens: parseK(tokenMatch[2]) } };
  }

  return { text: line + '\n' };
}
