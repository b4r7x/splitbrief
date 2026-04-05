import type { PlannerTokenUsage } from '../types.js';

export interface ToolUseInfo {
  name: string;
  input: Record<string, unknown>;
}

interface StreamParseResult {
  text: string | null;
  sessionId: string | null;
  isResult: boolean;
  usage: PlannerTokenUsage | null;
  toolUse: ToolUseInfo[] | null;
}

const NULL_RESULT: StreamParseResult = Object.freeze({
  text: null,
  sessionId: null,
  isResult: false,
  usage: null,
  toolUse: null,
});

export function parseStreamLine(line: string): StreamParseResult {
  if (!line.trim()) return NULL_RESULT;

  try {
    const event = JSON.parse(line);

    if (event.type === 'assistant' && event.message?.content) {
      const texts: string[] = [];
      const tools: ToolUseInfo[] = [];
      for (const block of event.message.content) {
        if (block.type === 'text' && block.text) {
          texts.push(block.text);
        } else if (block.type === 'tool_use' && block.name) {
          tools.push({ name: block.name, input: block.input ?? {} });
        }
      }
      return {
        text: texts.length > 0 ? texts.join('') : null,
        sessionId: event.session_id ?? null,
        isResult: false,
        usage: null,
        toolUse: tools.length > 0 ? tools : null,
      };
    }

    if (event.type === 'result') {
      const usage = event.usage
        ? { inputTokens: event.usage.input_tokens, outputTokens: event.usage.output_tokens }
        : null;
      return {
        text: typeof event.result === 'string' ? event.result : null,
        sessionId: event.session_id ?? null,
        isResult: true,
        usage,
        toolUse: null,
      };
    }

    if (event.session_id) {
      return { ...NULL_RESULT, sessionId: event.session_id };
    }

    return NULL_RESULT;
  } catch {
    return NULL_RESULT;
  }
}
