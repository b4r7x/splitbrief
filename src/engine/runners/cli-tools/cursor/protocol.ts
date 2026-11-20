import { error } from '../../../../utils/error.js';
import { isRecord, optionalString } from '../../../../utils/type-guards.js';
import type { CliProtocolEvent } from '../contract.js';
import { lastMessageGroupText } from '../final-group.js';

type CursorTerminalEvent = Extract<CliProtocolEvent, { type: 'result' }>;

function protocolFailure(code: string, message: string): CursorTerminalEvent {
  return {
    type: 'result',
    status: 'failed',
    text: '',
    nativeSessionId: null,
    error: { code, message },
    partial: false,
  };
}

function extractAssistantText(message: Record<string, unknown>): string | null {
  if (typeof message.content === 'string') return message.content;
  if (!Array.isArray(message.content)) return message.content === undefined ? '' : null;
  return message.content
    .filter(isRecord)
    .filter((block) => block.type === 'text')
    .map((block) => (typeof block.text === 'string' ? block.text : ''))
    .join('');
}

function parseCursorRecord(record: Record<string, unknown>): readonly CliProtocolEvent[] {
  const type = optionalString(record.type, { trim: true, nonEmpty: true });
  if (type === undefined) {
    return [protocolFailure('malformed-cursor-record', 'Cursor record is malformed')];
  }

  switch (type) {
    case 'system': {
      const sessionId = optionalString(record.session_id, { trim: true, nonEmpty: true });
      return sessionId === undefined ? [] : [{ type: 'session', nativeSessionId: sessionId }];
    }
    case 'user':
    case 'thinking':
      return [];
    case 'tool_call': {
      // The one `<name>ToolCall` key under `tool_call` carries the args and, once done, the result.
      const toolCall = isRecord(record.tool_call) ? record.tool_call : null;
      const key =
        toolCall === null
          ? undefined
          : Object.keys(toolCall).find((candidate) => candidate.endsWith('ToolCall'));
      const call = toolCall !== null && key !== undefined ? toolCall[key] : undefined;
      if (key === undefined || !isRecord(call)) {
        return [protocolFailure('malformed-cursor-record', 'Cursor tool call record is malformed')];
      }
      const id = optionalString(record.call_id, { trim: true, nonEmpty: true }) ?? null;
      const name = key.slice(0, -'ToolCall'.length);
      const input = isRecord(call.args) ? { ...call.args } : {};
      if (record.subtype === 'started') {
        return [{ type: 'tool-use', stage: 'started', id, name, input }];
      }
      return [
        {
          type: 'tool-use',
          stage: 'done',
          id,
          name,
          input,
          ...(call.result !== undefined && { output: call.result }),
        },
      ];
    }
    case 'assistant': {
      if (!isRecord(record.message)) {
        return [protocolFailure('malformed-cursor-record', 'Cursor message record is malformed')];
      }
      const text = extractAssistantText(record.message);
      return text === null
        ? [protocolFailure('malformed-cursor-record', 'Cursor message record is malformed')]
        : text.length > 0
          ? [{ type: 'text', channel: 'assistant', text }]
          : [];
    }
    case 'result': {
      const subtype = optionalString(record.subtype, { trim: true, nonEmpty: true });
      const failed = record.is_error === true || subtype !== 'success';
      const events: CliProtocolEvent[] = [];
      if (failed) {
        const message =
          optionalString(record.result, { trim: true, nonEmpty: true }) ?? 'Cursor result failed';
        events.push(protocolFailure('cursor-result-failed', message));
        return events;
      }
      events.push({
        type: 'result',
        status: 'completed',
        text: '',
        nativeSessionId: null,
        error: null,
        partial: false,
      });
      return events;
    }
    default:
      return [{ type: 'warning', code: 'unknown-cursor-record', message: 'Unknown Cursor record' }];
  }
}

export function cursorProtocolEvents(line: string): readonly CliProtocolEvent[] {
  if (line.trim().length === 0) return [];
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return [protocolFailure('malformed-cursor-json', 'Cursor emitted malformed JSON')];
  }
  if (!isRecord(value)) {
    return [protocolFailure('malformed-cursor-record', 'Cursor record is malformed')];
  }
  return parseCursorRecord(value);
}

export function cursorTerminal(input: {
  events: readonly CliProtocolEvent[];
}): CursorTerminalEvent {
  const terminal = input.events.findLast(
    (event): event is CursorTerminalEvent => event.type === 'result',
  );
  if (terminal === undefined) {
    throw error('cursor-protocol-failure', 'Cursor output ended without a terminal result');
  }
  const session = input.events.findLast(
    (event): event is Extract<CliProtocolEvent, { type: 'session' }> => event.type === 'session',
  );
  const nativeSessionId = session === undefined ? null : session.nativeSessionId;
  if (terminal.status !== 'completed') {
    return terminal.nativeSessionId === null && nativeSessionId !== null
      ? { ...terminal, nativeSessionId }
      : terminal;
  }
  return {
    ...terminal,
    text: lastMessageGroupText(input.events),
    ...(terminal.nativeSessionId === null && nativeSessionId !== null ? { nativeSessionId } : {}),
  };
}
