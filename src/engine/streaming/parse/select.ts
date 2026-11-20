import type { OutputFormat } from '../../../core/schemas/enums.js';
import type { ParsedLine } from '../../runners/types.js';
import { assertNever } from '../../../utils/type-guards.js';
import { createStreamedBlock } from '../final-text.js';
import { createStreamParser } from './stream-json/parser.js';
import type { StreamParseResult } from './stream-json/result.js';
import { parseJsonlLine } from './jsonl.js';
import { parseTextLine } from './text.js';
import { parseOpencodeLine } from './opencode.js';

function streamParsedLine(r: StreamParseResult): ParsedLine {
  // A tool's whole input re-announces it as started; only its `tool_result` (`toolUse`) closes it.
  const toolUseStart =
    r.toolUseStart !== undefined || r.toolUseInput !== undefined
      ? [...(r.toolUseStart ?? []), ...(r.toolUseInput ?? [])]
      : undefined;
  return {
    ...(r.text !== undefined ? { text: r.text } : {}),
    ...(r.channel !== undefined ? { channel: r.channel } : {}),
    ...(r.isResult !== undefined ? { isResult: r.isResult } : {}),
    ...(r.isError !== undefined ? { isError: r.isError } : {}),
    ...(r.sessionId !== undefined ? { sessionId: r.sessionId } : {}),
    ...(r.resolvedModel !== undefined ? { resolvedModel: r.resolvedModel } : {}),
    ...(r.subagentId !== undefined ? { subagentId: r.subagentId } : {}),
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
function createFinalRecordReconciler(): (r: StreamParseResult) => StreamParseResult {
  const openBlocks = new Map<string, ReturnType<typeof createStreamedBlock>>();
  return (r) => {
    if (r.textSemantics === undefined) return r;
    const key = r.subagentId ?? '';
    let block = openBlocks.get(key);
    if (block === undefined) {
      block = createStreamedBlock();
      openBlocks.set(key, block);
    }
    if (r.textSemantics === 'delta') {
      block.delta(r.text ?? '');
      return r;
    }
    const text = block.close(r.text);
    if (text.length === 0) return { ...r, text: undefined, channel: undefined };
    return { ...r, text };
  };
}

export function getLineParser(format: OutputFormat): (line: string) => ParsedLine {
  switch (format) {
    case 'stream-json': {
      const parse = createStreamParser();
      const reconcile = createFinalRecordReconciler();
      return (line) => streamParsedLine(reconcile(parse(line)));
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
