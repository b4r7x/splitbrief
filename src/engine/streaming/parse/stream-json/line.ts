import { isRecord } from '../../../../utils/type-guards.js';
import { toTokenDelta } from '../../../calls/usage/normalize.js';
import type { ToolUseInfo } from '../../../runners/types.js';
import { parsedUnknownRecordWarning, parsedMalformedRecordWarning } from '../warnings.js';
import {
  ToolResultBlock,
  AssistantEvent,
  TextBlock,
  ToolUseBlock,
  ResultEvent,
  InputEchoEvent,
  UserEvent,
  parseStreamEvent,
  SessionEvent,
} from './events.js';
import {
  type StreamParseResult,
  type OpenTools,
  type CollectMessageUsage,
  EMPTY_RESULT,
} from './result.js';
import { parseSystemProgress, parseRateLimitEvent } from './system-frames.js';

export function parseStreamLine(line: string): StreamParseResult {
  return parseLine(line);
}

function rememberTools(openTools: OpenTools | undefined, tools: readonly ToolUseInfo[]): void {
  for (const tool of tools) if (tool.id !== undefined) openTools?.set(tool.id, tool);
}

/**
 * A `tool_result` block is the tool's answer, so it closes the tool its `tool_use_id` names.
 * With no memory of that tool (a one-line parse), the tool closes under the placeholder name.
 */
function closedTools(content: readonly unknown[], openTools: OpenTools | undefined): ToolUseInfo[] {
  const closed: ToolUseInfo[] = [];
  for (const raw of content) {
    const block = ToolResultBlock.safeParse(raw);
    if (!block.success) continue;
    const id = block.data.tool_use_id;
    closed.push(openTools?.get(id) ?? { id, name: 'tool_use', input: {} });
    openTools?.delete(id);
  }
  return closed;
}

export function parseLine(
  line: string,
  collectUsage?: CollectMessageUsage,
  openTools?: OpenTools,
): StreamParseResult {
  if (!line.trim()) return EMPTY_RESULT;

  try {
    const event: unknown = JSON.parse(line);
    const record = isRecord(event) ? event : null;
    const usage = record === null ? undefined : collectUsage?.(record);
    const parentToolUseId = record?.parent_tool_use_id;
    const subagentId = typeof parentToolUseId === 'string' ? parentToolUseId : undefined;

    const assistant = AssistantEvent.safeParse(event);
    if (assistant.success) {
      const texts: string[] = [];
      const tools: ToolUseInfo[] = [];
      for (const raw of assistant.data.message.content) {
        const tb = TextBlock.safeParse(raw);
        if (tb.success) {
          texts.push(tb.data.text);
          continue;
        }
        const tu = ToolUseBlock.safeParse(raw);
        if (tu.success) {
          tools.push({
            ...(tu.data.id !== undefined && { id: tu.data.id }),
            name: tu.data.name,
            input: tu.data.input ?? {},
          });
        }
      }
      rememberTools(openTools, tools);
      return {
        text: texts.length > 0 ? texts.join('') : undefined,
        channel: texts.length > 0 ? 'assistant' : undefined,
        // A non-partial `assistant` record closes the message. Its text, when
        // present, restates streamed deltas rather than appending to them.
        textSemantics: 'final',
        sessionId: assistant.data.session_id ?? undefined,
        // The input is whole, but the tool has not run yet: its `tool_result` closes it.
        toolUseInput: tools.length > 0 ? tools : undefined,
        ...(usage !== undefined && { usage, usageSemantics: 'cumulative' }),
        ...(subagentId !== undefined && { subagentId }),
      };
    }

    const result = ResultEvent.safeParse(event);
    if (result.success) {
      const usage = toTokenDelta(result.data.usage ?? undefined) ?? undefined;
      return {
        text: result.data.result ?? undefined,
        channel: result.data.result !== undefined ? 'result' : undefined,
        sessionId: result.data.session_id ?? undefined,
        isResult: true,
        ...(result.data.is_error !== undefined && { isError: result.data.is_error }),
        ...(usage !== undefined && { usage, usageSemantics: 'final' }),
        ...(result.data.structured_output !== undefined && {
          structured: result.data.structured_output,
        }),
      };
    }

    const echo = InputEchoEvent.safeParse(event);
    if (echo.success) {
      const content = echo.data.message.content;
      return {
        inputAck:
          typeof content === 'string'
            ? content
            : content.flatMap((block) => (block.type === 'text' ? [block.text] : [])).join(''),
      };
    }

    const user = UserEvent.safeParse(event);
    if (user.success) {
      const closed = closedTools(user.data.message.content, openTools);
      if (closed.length > 0) {
        return {
          sessionId: user.data.session_id ?? undefined,
          toolUse: closed,
          ...(subagentId !== undefined && { subagentId }),
        };
      }
    }

    if (record) {
      const streamEvent = parseStreamEvent(record);
      if (streamEvent) {
        rememberTools(openTools, streamEvent.toolUseStart ?? []);
        const scoped = subagentId !== undefined ? { ...streamEvent, subagentId } : streamEvent;
        if (collectUsage === undefined) return scoped;
        const { usage: _messageUsage, usageSemantics: _semantics, ...rest } = scoped;
        return { ...rest, ...(usage !== undefined && { usage, usageSemantics: 'cumulative' }) };
      }
      const systemProgress = parseSystemProgress(record);
      if (systemProgress) return systemProgress;
      const rateLimit = parseRateLimitEvent(record);
      if (rateLimit) return rateLimit;
    }

    const session = SessionEvent.safeParse(event);
    if (session.success) {
      return { sessionId: session.data.session_id };
    }

    const warning = parsedUnknownRecordWarning({ parser: 'stream-json', value: event });
    return warning === null ? EMPTY_RESULT : { warning: [warning] };
  } catch {
    return {
      warning: [
        parsedMalformedRecordWarning({
          parser: 'stream-json',
          line,
          message: 'Malformed stream-json line skipped',
        }),
      ],
    };
  }
}
