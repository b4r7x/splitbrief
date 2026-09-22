import type { TokenDelta } from '../../core/schemas/tokens.js';
import { isRecord, optionalString } from '../../utils/type-guards.js';
import type { CliProtocolEvent } from '../runners/cli-tools/contract.js';

type AntigravityTerminalEvent = Extract<CliProtocolEvent, { type: 'result' }>;

const UNKNOWN_RECORD: CliProtocolEvent = {
  type: 'warning',
  code: 'unknown-antigravity-record',
  message: 'Unknown Antigravity record',
};

function protocolFailure(code: string, message: string): AntigravityTerminalEvent {
  return {
    type: 'result',
    status: 'failed',
    text: '',
    usage: null,
    nativeSessionId: null,
    error: { code, message },
    partial: false,
  };
}

function malformed(message: string): AntigravityTerminalEvent {
  return protocolFailure('malformed-antigravity-record', message);
}

function tokenCount(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}

// `output_tokens` includes `thinking_tokens` (`total_tokens` is input plus output in every captured
// frame) and the output counter excludes reasoning, so the thinking share is carved out of it.
function tokenDelta(raw: unknown): TokenDelta | null {
  if (!isRecord(raw)) return null;
  const inputTokens = tokenCount(raw.input_tokens);
  const output = tokenCount(raw.output_tokens);
  if (inputTokens === undefined || output === undefined) return null;
  const reasoningTokens = tokenCount(raw.thinking_tokens);
  const cacheReadTokens = tokenCount(raw.cache_read_tokens);
  const outputTokens = output - (reasoningTokens ?? 0);
  if (outputTokens < 0) return null;
  return {
    inputTokens,
    outputTokens,
    ...(reasoningTokens !== undefined && { reasoningTokens }),
    ...(cacheReadTokens !== undefined && { cacheReadTokens }),
  };
}

function parseToolStep(step: Record<string, unknown>): readonly CliProtocolEvent[] {
  const info = isRecord(step.tool_info) ? step.tool_info : {};
  const name =
    optionalString(step.tool_name, { trim: true, nonEmpty: true }) ??
    optionalString(info.name, { trim: true, nonEmpty: true });
  if (name === undefined) return [malformed('Antigravity tool step is malformed')];
  const id = typeof step.step_index === 'number' ? `step-${step.step_index}` : null;
  const input = isRecord(info.parameters) ? { ...info.parameters } : {};
  if (step.state === 'ACTIVE') return [{ type: 'tool-use', stage: 'started', id, name, input }];
  return [
    {
      type: 'tool-use',
      stage: 'done',
      id,
      name,
      input,
      ...(info.output !== undefined && { output: info.output }),
    },
  ];
}

// Each `agent_response` step reports its own usage and the `result` frame reports the turn total,
// so steps are booked as deltas and the terminal's usage replaces them rather than adding on.
function parseResponseStep(step: Record<string, unknown>): readonly CliProtocolEvent[] {
  const events: CliProtocolEvent[] = [];
  if (typeof step.text_delta === 'string' && step.text_delta.length > 0) {
    events.push({ type: 'text', channel: 'assistant', text: step.text_delta });
  }
  const usage = step.state === 'DONE' ? tokenDelta(step.usage) : null;
  if (usage !== null) events.push({ type: 'usage', usage, semantics: 'delta' });
  return events;
}

function parseStep(step: Record<string, unknown>): readonly CliProtocolEvent[] {
  switch (step.step_type) {
    case 'user_input':
      return [];
    case 'tool':
      return parseToolStep(step);
    case 'agent_response':
      return parseResponseStep(step);
    default:
      return [UNKNOWN_RECORD];
  }
}

function parseResult(result: Record<string, unknown>): AntigravityTerminalEvent {
  const status = optionalString(result.status, { trim: true, nonEmpty: true }) ?? 'UNKNOWN';
  const text = typeof result.response === 'string' ? result.response : '';
  const usage = tokenDelta(result.usage);
  const nativeSessionId =
    optionalString(result.conversation_id, { trim: true, nonEmpty: true }) ?? null;
  if (status === 'SUCCESS') {
    return {
      type: 'result',
      status: 'completed',
      text,
      usage,
      nativeSessionId,
      error: null,
      partial: false,
    };
  }
  const message =
    optionalString(result.error, { trim: true, nonEmpty: true }) ??
    optionalString(result.message, { trim: true, nonEmpty: true }) ??
    `Antigravity result ${status}`;
  return {
    type: 'result',
    status: 'failed',
    text,
    usage,
    nativeSessionId,
    error: { code: 'antigravity-result-failed', message },
    partial: true,
  };
}

function parseRecord(record: Record<string, unknown>): readonly CliProtocolEvent[] {
  const event = optionalString(record.event, { trim: true, nonEmpty: true });
  if (event === undefined) return [malformed('Antigravity record is malformed')];
  switch (event) {
    case 'init': {
      const conversationId = optionalString(record.conversation_id, { trim: true, nonEmpty: true });
      return conversationId === undefined
        ? []
        : [{ type: 'session', nativeSessionId: conversationId }];
    }
    case 'step_update':
      return isRecord(record.step_update)
        ? parseStep(record.step_update)
        : [malformed('Antigravity step record is malformed')];
    case 'result':
      return isRecord(record.result)
        ? [parseResult(record.result)]
        : [malformed('Antigravity result record is malformed')];
    default:
      return [UNKNOWN_RECORD];
  }
}

export function parseAntigravityLine(line: string): readonly CliProtocolEvent[] {
  if (line.trim().length === 0) return [];
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return [protocolFailure('malformed-antigravity-json', 'Antigravity emitted malformed JSON')];
  }
  if (!isRecord(value)) return [malformed('Antigravity record is malformed')];
  return parseRecord(value);
}
