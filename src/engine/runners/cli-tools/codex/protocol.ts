import type { TokenDelta } from '../../../../core/schemas/tokens.js';
import { error } from '../../../../utils/error.js';
import { isRecord, optionalString } from '../../../../utils/type-guards.js';
import { toTokenDelta } from '../../../calls/usage/normalize.js';
import type { CliProtocolEvent } from '../contract.js';
import { lastMessageGroupText } from '../final-group.js';

type CodexTerminalEvent = Extract<CliProtocolEvent, { type: 'result' }>;

function protocolFailure(
  code: string,
  message: string,
  providerType?: string | undefined,
): CodexTerminalEvent {
  return {
    type: 'result',
    status: 'failed',
    text: '',
    usage: null,
    nativeSessionId: null,
    error: {
      code: message.includes('max_output_tokens') ? 'output-token-limit' : code,
      message,
      ...(providerType !== undefined && { providerType }),
    },
    partial: false,
  };
}

const CODEX_EMBEDDED_ERROR_MESSAGE_DEPTH = 4;

function codexEmbeddedErrorMessage(text: string): string {
  let current = text.trim();
  if (current.length === 0) return text;

  for (let depth = 0; depth < CODEX_EMBEDDED_ERROR_MESSAGE_DEPTH; depth++) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(current);
    } catch {
      break;
    }
    if (!isRecord(parsed)) break;

    const nested = isRecord(parsed.error) ? parsed.error : undefined;
    const next =
      optionalString(nested?.message, { trim: true, nonEmpty: true }) ??
      (optionalString(parsed.type, { trim: true, nonEmpty: true }) === 'error'
        ? optionalString(parsed.message, { trim: true, nonEmpty: true })
        : undefined);
    if (next === undefined || next === current) break;
    current = next;
  }

  return current.length > 0 ? current : text;
}

function codexTurnFailedDetail(rawMessage: string | undefined): string {
  if (rawMessage === undefined) return 'Codex turn failed';
  const envelope = rawMessage.trim();
  if (envelope.length === 0) return 'Codex turn failed';
  const detail = codexEmbeddedErrorMessage(envelope);
  if (detail === envelope) return detail;
  return `${detail}\n${envelope}`;
}

function extractAgentText(item: Record<string, unknown>): string | null {
  if (typeof item.text === 'string') return item.text;
  if (!Array.isArray(item.content)) return item.content === undefined ? '' : null;

  const text = item.content
    .filter(isRecord)
    .filter((block) => block.type === 'text' || block.type === 'output_text')
    .map((block) => (typeof block.text === 'string' ? block.text : ''))
    .join('');
  return text;
}

const CODEX_ITEM_INPUT_FIELDS = ['command', 'cwd', 'changes'] as const;

function codexToolEvent(
  item: Record<string, unknown>,
  terminal: 'started' | 'completed',
): CliProtocolEvent | null {
  const itemType = optionalString(item.type, { trim: true, nonEmpty: true });
  if (!itemType || itemType === 'agent_message') return null;
  const name =
    itemType === 'collab_tool_call'
      ? (optionalString(item.tool, { trim: true, nonEmpty: true }) ?? itemType)
      : itemType;
  // A command or a file change carries its input on the item itself, not under `input`.
  const input = isRecord(item.input)
    ? { ...item.input }
    : isRecord(item.arguments)
      ? { ...item.arguments }
      : Object.fromEntries(
          CODEX_ITEM_INPUT_FIELDS.flatMap((field) =>
            item[field] === undefined ? [] : [[field, item[field]] as const],
          ),
        );
  const id = optionalString(item.id ?? item.item_id ?? item.call_id, {
    trim: true,
    nonEmpty: true,
  });
  if (terminal === 'started') {
    return { type: 'tool-use', stage: 'started', id: id ?? null, name, input };
  }
  const output = item.output ?? item.result ?? item.text ?? item.content ?? item.status;
  return {
    type: 'tool-use',
    id: id ?? null,
    name,
    input,
    ...(output !== undefined ? { output } : {}),
  };
}

function parseCodexRecord(record: Record<string, unknown>): readonly CliProtocolEvent[] {
  const type = optionalString(record.type, { trim: true, nonEmpty: true });
  if (type === undefined)
    return [protocolFailure('malformed-codex-record', 'Codex record is malformed')];

  switch (type) {
    case 'thread.started': {
      const threadId = optionalString(record.thread_id, { trim: true, nonEmpty: true });
      return threadId === undefined
        ? [protocolFailure('malformed-codex-record', 'Codex thread record is malformed')]
        : [{ type: 'session', nativeSessionId: threadId }];
    }
    case 'item.started':
    case 'item.completed': {
      if (!isRecord(record.item)) {
        return [protocolFailure('malformed-codex-record', 'Codex item record is malformed')];
      }
      const itemType = optionalString(record.item.type, { trim: true, nonEmpty: true });
      if (itemType === undefined) {
        return [protocolFailure('malformed-codex-record', 'Codex item record is malformed')];
      }
      if (itemType === 'agent_message' && type === 'item.completed') {
        const text = extractAgentText(record.item);
        return text === null
          ? [protocolFailure('malformed-codex-record', 'Codex message record is malformed')]
          : text.length > 0
            ? [{ type: 'text', channel: 'assistant', text }]
            : [];
      }
      const tool = codexToolEvent(record.item, type === 'item.completed' ? 'completed' : 'started');
      return tool === null ? [] : [tool];
    }
    case 'item.updated':
    case 'turn.started':
      return [];
    case 'turn.completed': {
      const hasUsage = Object.hasOwn(record, 'usage');
      let usage: TokenDelta | null = null;
      if (hasUsage && record.usage !== undefined) {
        if (!isRecord(record.usage)) {
          return [protocolFailure('malformed-codex-record', 'Codex terminal record is malformed')];
        }
        usage = toTokenDelta(record.usage);
        if (usage === null && Object.keys(record.usage).length > 0) {
          return [protocolFailure('malformed-codex-record', 'Codex usage record is malformed')];
        }
      }
      const events: CliProtocolEvent[] = [];
      if (usage !== null) events.push({ type: 'usage', usage, semantics: 'final' });
      events.push({
        type: 'result',
        status: 'completed',
        text: '',
        usage,
        nativeSessionId: null,
        error: null,
        partial: false,
      });
      return events;
    }
    case 'turn.failed': {
      const rawError = isRecord(record.error) ? record.error : undefined;
      const rawMessage =
        rawError === undefined
          ? undefined
          : optionalString(rawError.message, { trim: true, nonEmpty: true });
      const providerType =
        rawError === undefined
          ? undefined
          : optionalString(rawError.type, { trim: true, nonEmpty: true });
      return [
        protocolFailure('codex-turn-failed', codexTurnFailedDetail(rawMessage), providerType),
      ];
    }
    case 'error': {
      const message = optionalString(record.message, { trim: true, nonEmpty: true });
      return [protocolFailure('codex-error', message ?? 'Codex reported an error')];
    }
    default:
      return [{ type: 'warning', code: 'unknown-codex-record', message: 'Unknown Codex record' }];
  }
}

export function codexProtocolEvents(line: string): readonly CliProtocolEvent[] {
  if (line.trim().length === 0) return [];
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return [protocolFailure('malformed-codex-json', 'Codex emitted malformed JSON')];
  }
  if (!isRecord(value)) {
    return [protocolFailure('malformed-codex-record', 'Codex record is malformed')];
  }
  return parseCodexRecord(value);
}

export function codexTerminal(input: { events: readonly CliProtocolEvent[] }): CodexTerminalEvent {
  const terminal = input.events.findLast(
    (event): event is CodexTerminalEvent => event.type === 'result',
  );
  if (terminal === undefined) {
    throw error('codex-protocol-failure', 'Codex output ended without a terminal result');
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
