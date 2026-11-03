import type { OutputFormat } from '../../core/schemas/enums.js';
import type { ParsedLine } from '../runners/types.js';
import { assertNever, isRecord } from '../../utils/type-guards.js';
import { reconcileFinalText } from './final-text.js';
import { createStreamParser, type StreamParseResult } from './parse-stream-json.js';
import { parseJsonlLine } from './parse-jsonl.js';
import { parseTextLine } from './parse-text.js';
import { parseOpencodeLine } from './parse-opencode.js';

function streamParsedLine(r: StreamParseResult): ParsedLine {
  // A tool's whole input re-announces it as started; only its `tool_result` (`toolUse`) closes it.
  const toolUseStart =
    r.toolUseStart !== undefined || r.toolUseInput !== undefined
      ? [...(r.toolUseStart ?? []), ...(r.toolUseInput ?? [])]
      : undefined;
  return {
    ...(r.text !== undefined ? { text: r.text } : {}),
    ...(r.channel !== undefined ? { channel: r.channel } : {}),
    ...(r.usage !== undefined ? { usage: r.usage } : {}),
    ...(r.usageSemantics !== undefined ? { usageSemantics: r.usageSemantics } : {}),
    ...(r.isResult !== undefined ? { isResult: r.isResult } : {}),
    ...(r.isError !== undefined ? { isError: r.isError } : {}),
    ...(r.sessionId !== undefined ? { sessionId: r.sessionId } : {}),
    ...(r.toolUse !== undefined ? { toolUse: r.toolUse } : {}),
    ...(toolUseStart !== undefined ? { toolUseStart } : {}),
    ...(r.toolUseDelta !== undefined ? { toolUseDelta: r.toolUseDelta } : {}),
    ...(r.warning !== undefined ? { warning: r.warning } : {}),
    ...(r.isHeartbeat !== undefined ? { isHeartbeat: r.isHeartbeat } : {}),
  };
}

/**
 * With partial messages on, an `assistant` record restates the deltas its block
 * streamed: keep only the text no delta streamed. Each subagent streams its own blocks.
 */
function createFinalRecordReconciler(): (r: StreamParseResult, line: string) => StreamParseResult {
  const openBlocks = new Map<string, string>();
  return (r, line) => {
    if (r.textSemantics === undefined) return r;
    const record: unknown = r.isSubagent ? JSON.parse(line) : null;
    const block = isRecord(record) ? String(record.parent_tool_use_id) : '';
    const blockText = openBlocks.get(block) ?? '';
    if (r.textSemantics === 'delta') {
      openBlocks.set(block, blockText + (r.text ?? ''));
      return r;
    }
    openBlocks.delete(block);
    if (r.text === undefined) return r;
    const reconciliation = reconcileFinalText(blockText, r.text);
    return reconciliation.kind === 'none'
      ? { ...r, text: undefined, channel: undefined }
      : { ...r, text: reconciliation.text };
  };
}

export function getLineParser(format: OutputFormat): (line: string) => ParsedLine {
  switch (format) {
    case 'stream-json': {
      const parse = createStreamParser();
      const reconcile = createFinalRecordReconciler();
      return (line) => streamParsedLine(reconcile(parse(line), line));
    }
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
