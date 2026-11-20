import { parseLine } from './line.js';
import type { OpenTools, StreamParseResult } from './result.js';

export function createStreamParser(): (line: string) => StreamParseResult {
  const openTools: OpenTools = new Map();
  return (line) => {
    const parsed = parseLine(line, openTools);
    if (parsed.isResult) openTools.clear();
    return parsed;
  };
}
