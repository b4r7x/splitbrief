import type { TokenDelta } from '../../core/schemas/tokens.js';
import { toProviderTokenDelta } from '../calls/usage.js';
import { isRecord, optionalString } from '../../utils/type-guards.js';
import type { CliProtocolEvent } from '../runners/cli-tools/contract.js';

type AntigravityTerminalEvent = Extract<CliProtocolEvent, { type: 'result' }>;

function unknown(kind: 'record' | 'step', type: unknown): CliProtocolEvent {
  const named = optionalString(type, { trim: true, nonEmpty: true });
  const message = `Unknown Antigravity ${kind}`;
  return {
    type: 'warning',
    code: 'unknown-antigravity-record',
    message: named === undefined ? message : `${message}: ${named}`,
  };
}

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
  return toProviderTokenDelta({
    inputTokens,
    outputTokens: output - (reasoningTokens ?? 0),
    ...(reasoningTokens !== undefined && { reasoningTokens }),
    ...(cacheReadTokens !== undefined && { cacheReadTokens }),
  });
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

// `user_input` and `system_message` are what agy feeds the model (the prompt; its own notices,
// such as a finished background task or an auto-approved plan) and carry no text, usage or tools.
// `checkpoint` (written mid-turn on a long call) and `finish` (closes the turn) carry only a
// duration, nothing SPLITBRIEF uses.
function parseStep(step: Record<string, unknown>): readonly CliProtocolEvent[] {
  switch (step.step_type) {
    case 'user_input':
    case 'system_message':
    case 'checkpoint':
    case 'finish':
      return [];
    case 'tool':
      return parseToolStep(step);
    case 'agent_response':
      return parseResponseStep(step);
    default:
      return [unknown('step', step.step_type)];
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
      ...(result.structured_output !== undefined && { structured: result.structured_output }),
    };
  }
  const message =
    optionalString(isRecord(result.error) ? result.error.message : result.error, {
      trim: true,
      nonEmpty: true,
    }) ??
    optionalString(result.message, { trim: true, nonEmpty: true }) ??
    `Antigravity result ${status}`;
  return {
    type: 'result',
    status: 'failed',
    text,
    usage,
    nativeSessionId,
    // agy names its stdin "stream input": a line it cannot read is the prompt SPLITBRIEF sent.
    error: {
      code: /stream input/i.test(message) ? 'prompt-transport-error' : 'antigravity-result-failed',
      message,
    },
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
      return [unknown('record', event)];
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
