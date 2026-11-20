import type { ParsedLine } from '../../runners/types.js';

export function parseTextLine(line: string): ParsedLine {
  if (!line.trim()) return {};

  if (/Tokens:\s*([\d.]+k?)\s*sent,\s*([\d.]+k?)\s*received/i.test(line)) return {};

  return { text: line + '\n', channel: 'stdout' };
}
