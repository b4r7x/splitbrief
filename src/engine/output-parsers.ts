import type { OutputFormat, PlannerTokenUsage } from '../types.js';
import { parseStreamLine } from './claude-stream.js';

interface ParsedLine {
  text?: string;
  usage?: PlannerTokenUsage;
  isResult?: boolean;
}

export function parseTextLine(line: string): ParsedLine {
  if (!line.trim()) return {};

  const tokenMatch = line.match(/Tokens:\s*([\d.]+k?)\s*sent,\s*([\d.]+k?)\s*received/i);
  if (tokenMatch) {
    const parseK = (v: string) => {
      const n = parseFloat(v);
      return v.toLowerCase().endsWith('k') ? Math.round(n * 1000) : Math.round(n);
    };
    return { usage: { inputTokens: parseK(tokenMatch[1]), outputTokens: parseK(tokenMatch[2]) } };
  }

  return { text: line + '\n' };
}

export function parseJsonlLine(line: string): ParsedLine {
  if (!line.trim()) return {};

  try {
    const event = JSON.parse(line);

    if (event.type === 'item.completed' && event.item?.type === 'agent_message') {
      const content = event.item.content;
      if (Array.isArray(content)) {
        const texts: string[] = [];
        for (const block of content) {
          if ((block.type === 'text' || block.type === 'output_text') && block.text) {
            texts.push(block.text);
          }
        }
        if (texts.length > 0) return { text: texts.join('') };
      }
      if (typeof event.item.text === 'string') return { text: event.item.text };
    }

    if (event.type === 'turn.completed' && event.usage) {
      return {
        usage: {
          inputTokens: event.usage.input_tokens ?? event.usage.prompt_tokens ?? 0,
          outputTokens: event.usage.output_tokens ?? event.usage.completion_tokens ?? 0,
        },
      };
    }

    if (event.text) return { text: event.text };
    if (event.content) return { text: typeof event.content === 'string' ? event.content : JSON.stringify(event.content) };

    return {};
  } catch {
    return {};
  }
}

export function getLineParser(format: OutputFormat): (line: string) => ParsedLine {
  switch (format) {
    case 'stream-json': return (line) => {
      const r = parseStreamLine(line);
      return { text: r.text ?? undefined, usage: r.usage ?? undefined, isResult: r.isResult || undefined };
    };
    case 'jsonl': return parseJsonlLine;
    case 'text': return parseTextLine;
    case 'opencode': return parseOpencodeLine;
  }
}

export function parseOpencodeLine(line: string): ParsedLine {
  const trimmed = line.trim();
  if (!trimmed) return {};

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return {};
  }

  if (parsed.type === 'text' && typeof parsed.text === 'string') {
    return { text: parsed.text };
  }

  if (parsed.type === 'step_finish') {
    const usage = parsed.usage as { tokens: { input: number; output: number } } | undefined;
    if (usage?.tokens) {
      return { usage: { inputTokens: usage.tokens.input, outputTokens: usage.tokens.output } };
    }
  }

  return {};
}

export function accumulateUsage(
  current: PlannerTokenUsage | null,
  delta: PlannerTokenUsage,
): PlannerTokenUsage {
  if (current) {
    return {
      inputTokens: current.inputTokens + delta.inputTokens,
      outputTokens: current.outputTokens + delta.outputTokens,
    };
  }
  return { ...delta };
}
