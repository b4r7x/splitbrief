import type { PlannerTokenUsage } from '../types.js';

interface StreamParseResult {
  text: string | null;
  sessionId: string | null;
  isResult: boolean;
  usage: PlannerTokenUsage | null;
  costUsd: number | null;
}

const NULL_RESULT: StreamParseResult = {
  text: null,
  sessionId: null,
  isResult: false,
  usage: null,
  costUsd: null,
};

export function parseStreamLine(line: string): StreamParseResult {
  if (!line.trim()) return NULL_RESULT;

  try {
    const event = JSON.parse(line);

    if (event.type === 'assistant' && event.message?.content) {
      const texts: string[] = [];
      for (const block of event.message.content) {
        if (block.type === 'text' && block.text) {
          texts.push(block.text);
        }
      }
      return {
        text: texts.length > 0 ? texts.join('') : null,
        sessionId: event.session_id ?? null,
        isResult: false,
        usage: null,
        costUsd: null,
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
        costUsd: typeof event.total_cost_usd === 'number' ? event.total_cost_usd : null,
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
