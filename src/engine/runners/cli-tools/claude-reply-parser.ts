import { createStreamParser, type StreamParseResult } from '../../streaming/parse-stream-json.js';
import { appendMessage, reconcileFinalText } from '../../streaming/final-text.js';
import { isRecord } from '../../../utils/type-guards.js';

export function createClaudeReplyParser(): (line: string) => StreamParseResult {
  const parse = createStreamParser();
  let blockText = '';
  let messageText = '';
  let carriedText = '';
  let resumesCut = false;
  let inChain = false;
  let lastClosedText = '';
  let stopReason: string | undefined;
  let sessionId: string | undefined;
  let turnEnded = false;
  const tools = new Map<string, { id: string | undefined; name: string; input: string }>();
  const chainText = (text: string) =>
    resumesCut ? carriedText + text : appendMessage(carriedText, text);

  return (line) => {
    const parsed = parse(line);
    sessionId = parsed.sessionId ?? sessionId;
    if (turnEnded && !parsed.isResult) {
      blockText = '';
      messageText = '';
      carriedText = '';
      resumesCut = false;
      inChain = false;
      lastClosedText = '';
      stopReason = undefined;
      tools.clear();
      turnEnded = false;
    }
    if (!parsed.isSubagent) {
      if (parsed.isMessageStart) {
        const closed = chainText(messageText);
        if (closed.length > 0) lastClosedText = closed;
        const cut = stopReason === 'max_tokens';
        const continues = cut || (inChain && stopReason === 'tool_use');
        carriedText = continues ? closed : '';
        resumesCut = cut;
        inChain = continues;
        blockText = '';
        messageText = '';
        stopReason = undefined;
      }
      if (parsed.stopReason !== undefined) stopReason = parsed.stopReason;
      if (
        parsed.text &&
        !parsed.isResult &&
        (parsed.channel === 'assistant' || parsed.channel === 'stdout')
      ) {
        if (parsed.textSemantics === 'final') {
          const reconciliation = reconcileFinalText(blockText, parsed.text);
          if (reconciliation.kind === 'full' || reconciliation.kind === 'suffix')
            messageText += reconciliation.text;
          blockText = '';
        } else {
          blockText += parsed.text;
          messageText += parsed.text;
        }
      }
    }
    const rebuilt: StreamParseResult = {
      ...parsed,
      ...(parsed.isResult && {
        sessionId,
        text: parsed.isError
          ? parsed.text
          : parsed.text
            ? chainText(parsed.text)
            : chainText(messageText) || lastClosedText,
      }),
    };
    if (parsed.toolUseStart !== undefined) {
      const record: unknown = JSON.parse(line);
      if (isRecord(record) && isRecord(record.event) && typeof record.event.index === 'number') {
        for (const tool of parsed.toolUseStart) {
          tools.set(`content-block-${record.event.index}`, {
            id: tool.id,
            name: tool.name,
            input: '',
          });
        }
      }
    }
    if (parsed.toolUseDelta !== undefined) {
      rebuilt.toolUseDelta = parsed.toolUseDelta.map((delta) => {
        const tool = delta.id === undefined ? undefined : tools.get(delta.id);
        if (tool === undefined) return delta;
        tool.input += delta.inputDelta;
        const input = parseToolInput(tool.input);
        if (input !== null) {
          rebuilt.toolUseInput = [
            ...(rebuilt.toolUseInput ?? []),
            { id: tool.id, name: tool.name, input },
          ];
        }
        return { ...delta, id: tool.id, name: tool.name };
      });
    }
    if (parsed.isResult) turnEnded = true;
    return rebuilt;
  };
}

function parseToolInput(text: string): Record<string, unknown> | null {
  try {
    const input: unknown = JSON.parse(text);
    return isRecord(input) ? input : null;
  } catch {
    return null;
  }
}
