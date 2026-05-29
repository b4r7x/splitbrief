import type { OutputFormat } from '../../core/schemas/enums.js';
import type { ParsedLine } from '../runners/types.js';
import { assertNever } from '../../utils/type-guards.js';
import { parseStreamLine } from './parse-stream-json.js';
import { parseJsonlLine } from './parse-jsonl.js';
import { parseTextLine } from './parse-text.js';
import { parseOpencodeLine } from './parse-opencode.js';

function wrapStreamParser(line: string): ParsedLine {
  const r = parseStreamLine(line);
  return {
    ...(r.text !== undefined ? { text: r.text } : {}),
    ...(r.usage !== undefined ? { usage: r.usage } : {}),
    ...(r.isResult !== undefined ? { isResult: r.isResult } : {}),
    ...(r.sessionId !== undefined ? { sessionId: r.sessionId } : {}),
    ...(r.toolUse !== undefined ? { toolUse: r.toolUse } : {}),
  };
}

export function getLineParser(format: OutputFormat): (line: string) => ParsedLine {
  switch (format) {
    case 'stream-json':
      return wrapStreamParser;
    case 'jsonl':
      return parseJsonlLine;
    case 'text':
      return parseTextLine;
    case 'opencode':
      return parseOpencodeLine;
    default:
      return assertNever(format);
  }
}
