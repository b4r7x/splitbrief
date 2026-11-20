import { error } from '../../../../utils/error.js';
import { isRecord, optionalString } from '../../../../utils/type-guards.js';
import type { CliProtocolEvent } from '../contract.js';

type CommandCodeTerminalEvent = Extract<CliProtocolEvent, { type: 'result' }>;

function protocolFailure(code: string, message: string): CommandCodeTerminalEvent {
  return {
    type: 'result',
    status: 'failed',
    text: '',
    nativeSessionId: null,
    error: { code, message },
    partial: false,
  };
}

function malformedRecord(): CommandCodeTerminalEvent {
  return protocolFailure('malformed-command-code-record', 'Command Code record is malformed');
}

function parseEventRecord(record: Record<string, unknown>): readonly CliProtocolEvent[] {
  if (!isRecord(record.event)) return [];
  // `tool_queued` carries the input and comes before the permission check and the
  // run, so the isolation guard sees the call first; `tool_running` has no input.
  if (record.event.type !== 'tool_queued') return [];
  const name = optionalString(record.event.toolName, { trim: true, nonEmpty: true });
  if (name === undefined) return [];
  const id = optionalString(record.event.toolCallId, { trim: true, nonEmpty: true });
  const input = isRecord(record.event.input) ? record.event.input : {};
  return [{ type: 'tool-use', id: id ?? null, name, input }];
}

function parseResultRecord(record: Record<string, unknown>): readonly CliProtocolEvent[] {
  const events: CliProtocolEvent[] = [];
  const sessionId = optionalString(record.sessionId, { trim: true, nonEmpty: true });
  if (sessionId !== undefined) events.push({ type: 'session', nativeSessionId: sessionId });

  if (optionalString(record.subtype, { trim: true, nonEmpty: true }) !== 'success') {
    // A failed frame carries its reason in `error` as a plain string and omits
    // `stopReason` entirely, so `error` has to be read first or the real cause
    // ("Not authenticated…") is replaced by the generic fallback.
    const stopReason = optionalString(record.stopReason, { trim: true, nonEmpty: true });
    const stopMessage =
      stopReason === 'max_turns' ? 'The tool reached its turn limit.' : stopReason;
    const message =
      optionalString(record.error, { trim: true, nonEmpty: true }) ??
      stopMessage ??
      optionalString(record.finalText, { trim: true, nonEmpty: true }) ??
      'Command Code result failed';
    events.push(protocolFailure('command-code-result-failed', message));
    return events;
  }

  events.push({
    type: 'result',
    status: 'completed',
    text: optionalString(record.finalText) ?? '',
    nativeSessionId: sessionId ?? null,
    error: null,
    partial: false,
  });
  return events;
}

function parseCommandCodeRecord(record: Record<string, unknown>): readonly CliProtocolEvent[] {
  const type = optionalString(record.type, { trim: true, nonEmpty: true });
  if (type === undefined) return [malformedRecord()];

  switch (type) {
    case 'event':
      return parseEventRecord(record);
    case 'result':
      return parseResultRecord(record);
    default:
      return [
        {
          type: 'warning',
          code: 'unknown-command-code-record',
          message: 'Unknown Command Code record',
        },
      ];
  }
}

export function commandCodeProtocolEvents(line: string): readonly CliProtocolEvent[] {
  if (line.trim().length === 0) return [];
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return [protocolFailure('malformed-command-code-json', 'Command Code emitted malformed JSON')];
  }
  if (!isRecord(value)) return [malformedRecord()];
  return parseCommandCodeRecord(value);
}

export function commandCodeTerminal(input: {
  events: readonly CliProtocolEvent[];
}): CommandCodeTerminalEvent {
  const terminal = input.events.findLast(
    (event): event is CommandCodeTerminalEvent => event.type === 'result',
  );
  if (terminal === undefined) {
    throw error(
      'command-code-protocol-failure',
      'Command Code output ended without a terminal result',
    );
  }
  const session = input.events.findLast(
    (event): event is Extract<CliProtocolEvent, { type: 'session' }> => event.type === 'session',
  );
  const nativeSessionId = session === undefined ? null : session.nativeSessionId;
  return terminal.nativeSessionId === null && nativeSessionId !== null
    ? { ...terminal, nativeSessionId }
    : terminal;
}
