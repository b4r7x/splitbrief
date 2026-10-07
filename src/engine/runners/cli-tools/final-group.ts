import type { TokenDelta } from '../../../core/schemas/tokens.js';
import { accumulateTokenUsage } from '../../calls/usage.js';
import { appendMessage } from '../../streaming/final-text.js';
import { envelopeErrorDetail } from '../../streaming/error-envelope.js';
import { isRecord } from '../../../utils/type-guards.js';
import type { CliProtocolEvent } from './contract.js';

type FinalGroupResult = Extract<CliProtocolEvent, { type: 'result' }>;
type TextEvent = Extract<CliProtocolEvent, { type: 'text' }>;

/**
 * REQ-013 exact final group: only the text emitted after the last tool call is
 * the authoritative final response; earlier messages, partials, and tool-call
 * text are evidence, never content. Each text event of these protocols is one
 * whole message, so every message in the group starts on its own line. A turn
 * that ends on a tool call has no group, and its last message stands in for it.
 */
export function lastMessageGroupText(events: readonly CliProtocolEvent[]): string {
  const isMessage = (event: CliProtocolEvent | undefined): event is TextEvent =>
    event?.type === 'text' && event.channel !== 'stderr';
  const boundary = events.findLastIndex((event) => event.type === 'tool-use');
  let groupText = '';
  for (let index = boundary + 1; index < events.length; index += 1) {
    const event = events[index];
    if (isMessage(event)) groupText = appendMessage(groupText, event.text);
  }
  if (groupText.length > 0) return groupText;
  return events.findLast(isMessage)?.text ?? '';
}

/**
 * The recorded terminal carries exactly the final group; the process exit stays
 * the terminal record for this stdout-final family (REQ-014 is satisfied by the
 * exit contract).
 */
export function finalGroupTerminal(input: {
  events: readonly CliProtocolEvent[];
  includeFinalGroupText: boolean;
}): FinalGroupResult {
  const explicit = input.events.findLast(
    (event): event is FinalGroupResult => event.type === 'result',
  );
  if (explicit !== undefined) return explicit;

  const groupText = input.includeFinalGroupText ? lastMessageGroupText(input.events) : '';
  let usage: TokenDelta | null = null;
  let nativeSessionId: string | null = null;
  for (const event of input.events) {
    if (event.type === 'usage') usage = accumulateTokenUsage(usage, event.usage, event.semantics);
    if (event.type === 'session') nativeSessionId = event.nativeSessionId;
  }
  return {
    type: 'result',
    status: 'completed',
    text: groupText,
    usage,
    nativeSessionId,
    error: null,
    partial: false,
  };
}

export function errorLineProtocolEvents(input: {
  line: string;
  errorCode: string;
  defaultMessage: string;
}): readonly CliProtocolEvent[] | null {
  let value: unknown;
  try {
    value = JSON.parse(input.line.trim());
  } catch {
    return null;
  }
  if (!isRecord(value) || value.type !== 'error') return null;
  const nativeSessionId =
    typeof value.sessionID === 'string'
      ? value.sessionID
      : typeof value.sessionId === 'string'
        ? value.sessionId
        : null;
  const events: CliProtocolEvent[] = [];
  if (nativeSessionId !== null) events.push({ type: 'session', nativeSessionId });
  const envelope = isRecord(value.error) ? value.error : undefined;
  const data = envelope !== undefined && isRecord(envelope.data) ? envelope.data : undefined;
  const status = errorStatus(envelope?.status ?? data?.statusCode);
  const providerType = errorProviderType(envelope?.type);
  events.push({
    type: 'warning',
    code: input.errorCode,
    message: envelopeErrorDetail(value, input.defaultMessage),
    ...(status !== undefined && { status }),
    ...(providerType !== undefined && { providerType }),
  });
  return events;
}

function errorStatus(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) ? value : undefined;
}

function errorProviderType(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

export function errorLineTerminal(input: {
  events: readonly CliProtocolEvent[];
  includeFinalGroupText: boolean;
  errorCode: string;
}): FinalGroupResult {
  const group = finalGroupTerminal(input);
  const last = input.events.findLast(
    (event) =>
      event.type === 'text' ||
      event.type === 'tool-use' ||
      (event.type === 'warning' && event.code === input.errorCode),
  );
  if (last?.type !== 'warning') return group;
  return {
    type: 'result',
    status: 'failed',
    text: '',
    usage: group.usage,
    nativeSessionId: group.nativeSessionId,
    error: {
      code: input.errorCode,
      message: last.message,
      ...(last.status !== undefined && { status: last.status }),
      ...(last.providerType !== undefined && { providerType: last.providerType }),
    },
    partial: true,
  };
}
