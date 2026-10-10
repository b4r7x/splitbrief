import { z } from 'zod';
import type {
  ParsedTextSemantics,
  ParsedUsageSemantics,
  ParsedTextChannel,
  ParsedWarningInfo,
  ToolUseDeltaInfo,
  ToolUseInfo,
} from '../runners/types.js';
import type { TokenDelta } from '../../core/schemas/tokens.js';
import { accumulateTokenUsage, BackendTokenUsageSchema, toTokenDelta } from '../calls/usage.js';
import { formatStoredReset } from '../../core/recovery/reset-clock.js';
import { formatDuration } from '../../utils/format-time.js';
import { isRecord, optionalString } from '../../utils/type-guards.js';
import { parsedMalformedRecordWarning, parsedUnknownRecordWarning } from './parser-warnings.js';

export interface StreamParseResult {
  text?: string | undefined;
  inputAck?: string | undefined;
  channel?: ParsedTextChannel | undefined;
  /** `final` closes an assistant record; its text, when present, restates streamed deltas. */
  textSemantics?: ParsedTextSemantics | undefined;
  sessionId?: string | undefined;
  isResult?: boolean | undefined;
  isSessionInit?: boolean | undefined;
  isError?: boolean | undefined;
  usage?: TokenDelta | undefined;
  usageSemantics?: ParsedUsageSemantics | undefined;
  /** Tools a `user` record's `tool_result` closed: the tool ran and answered. */
  toolUse?: ToolUseInfo[] | undefined;
  /** Tools an `assistant` record gave their whole input; each stays open until its result. */
  toolUseInput?: ToolUseInfo[] | undefined;
  toolUseStart?: ToolUseInfo[] | undefined;
  toolUseDelta?: ToolUseDeltaInfo[] | undefined;
  warning?: ParsedWarningInfo[] | undefined;
  /** A non-null `parent_tool_use_id`: the record belongs to a subagent, not the main loop. */
  isSubagent?: boolean | undefined;
  /** A `message_start` opened a message. */
  isMessageStart?: boolean | undefined;
  /** `message_delta.delta.stop_reason`: why the open message ended. */
  stopReason?: string | undefined;
  /** A frame that says nothing to the operator and only proves the CLI is still working. */
  isHeartbeat?: boolean | undefined;
  /** The result record's `structured_output`, when the call ran with `--json-schema`. */
  structured?: unknown;
}

export const EMPTY_RESULT: StreamParseResult = Object.freeze({});

type MessageUsage = z.infer<typeof BackendTokenUsageSchema>;
type CollectMessageUsage = (event: Record<string, unknown>) => TokenDelta | undefined;
/** The open tools by `tool_use_id`, so a `tool_result` closes a tool with its name and input. */
type OpenTools = Map<string, ToolUseInfo>;

/** A delta with no message_start behind it still reports real usage. */
const ORPHAN_MESSAGE_DELTA_ID = 'message-delta-without-message-start';

/** One parser per invocation: message snapshots replace, distinct messages add. */
export function createStreamParser(): (line: string) => StreamParseResult {
  const messages = new Map<string, MessageUsage>();
  const openTools: OpenTools = new Map();
  let activeMessage: string | undefined;
  let completedUsage: TokenDelta | null = null;
  let turnUsage: TokenDelta | null = null;
  let turnEnded = false;

  const collect: CollectMessageUsage = (event) => {
    // The invocation result covers the main loop, not nested subagent messages.
    if (event.parent_tool_use_id != null) return undefined;
    const stream = event.type === 'stream_event' && isRecord(event.event) ? event.event : null;
    const message =
      event.type === 'assistant'
        ? event.message
        : stream?.type === 'message_start'
          ? stream.message
          : undefined;
    let id: string | undefined;
    let raw: unknown;
    if (isRecord(message)) {
      id = firstString(message.id);
      if (stream?.type === 'message_start') activeMessage = id;
      if (!isRecord(message.usage)) return undefined;
      // Assistant/message_start output is a placeholder. Only message_delta or
      // the invocation result establishes the generated count.
      const { output_tokens: _placeholder, ...inputUsage } = message.usage;
      raw = inputUsage;
    } else if (stream?.type === 'message_delta') {
      // Dropping a delta no message_start opened would erase the only usage
      // evidence a terminal result without usage ever sees, so it stands in
      // as a message of its own and the aggregate keeps it.
      id = activeMessage ?? ORPHAN_MESSAGE_DELTA_ID;
      raw = stream.usage;
    } else {
      if (stream?.type === 'message_stop') activeMessage = undefined;
      return undefined;
    }
    if (id === undefined) return undefined;
    const parsed = BackendTokenUsageSchema.safeParse(raw);
    if (!parsed.success) return undefined;
    messages.set(id, { ...messages.get(id), ...parsed.data });

    let aggregate: TokenDelta | null = null;
    let outputTotal = 0;
    let allOutputsKnown = true;
    for (const value of messages.values()) {
      const usage = toTokenDelta(value);
      if (usage === null) continue;
      aggregate = accumulateTokenUsage(aggregate, usage);
      if (usage.providerTotals?.output === undefined) allOutputsKnown = false;
      else outputTotal += usage.providerTotals.output;
    }
    if (aggregate === null) return undefined;
    const { providerTotals: _lastMessageTotals, ...counters } = aggregate;
    return {
      ...counters,
      ...(allOutputsKnown && { providerTotals: { output: outputTotal } }),
    };
  };
  return (line) => {
    const parsed = parseLine(line, collect, openTools);
    if (turnEnded && !parsed.isResult) {
      if (turnUsage !== null) completedUsage = addTurnUsage(completedUsage, turnUsage);
      turnUsage = null;
      turnEnded = false;
    }
    if (parsed.isResult) {
      turnUsage = parsed.usage ?? turnUsage;
      turnEnded = true;
      messages.clear();
      openTools.clear();
      activeMessage = undefined;
      const usage = turnUsage === null ? completedUsage : addTurnUsage(completedUsage, turnUsage);
      return {
        ...parsed,
        ...(usage !== null && { usage, usageSemantics: 'final' }),
      };
    }
    if (parsed.usage === undefined) return parsed;
    turnUsage = parsed.usage;
    return { ...parsed, usage: addTurnUsage(completedUsage, turnUsage) };
  };
}

function addTurnUsage(completed: TokenDelta | null, turn: TokenDelta): TokenDelta {
  const total = accumulateTokenUsage(completed, turn);
  if (completed === null) return total;
  const input = completed.providerTotals?.input;
  const output = completed.providerTotals?.output;
  const turnInput = turn.providerTotals?.input;
  const turnOutput = turn.providerTotals?.output;
  const { providerTotals: _latest, ...counters } = total;
  return {
    ...counters,
    providerTotals: {
      ...(input !== undefined && turnInput !== undefined && { input: input + turnInput }),
      ...(output !== undefined && turnOutput !== undefined && { output: output + turnOutput }),
    },
  };
}

const TextBlock = z.object({ type: z.literal('text'), text: z.string() });
const ToolUseBlock = z.object({
  type: z.literal('tool_use'),
  id: z.string().optional(),
  name: z.string(),
  input: z.record(z.string(), z.unknown()).optional(),
});

const ToolResultBlock = z.object({ type: z.literal('tool_result'), tool_use_id: z.string() });

const AssistantEvent = z.object({
  type: z.literal('assistant'),
  session_id: z.string().optional(),
  message: z.object({ content: z.array(z.unknown()) }),
});

const InputEchoEvent = z.object({
  type: z.literal('user'),
  parent_tool_use_id: z.null(),
  message: z.object({ role: z.literal('user'), content: z.string() }),
});

const UserEvent = z.object({
  type: z.literal('user'),
  session_id: z.string().optional(),
  message: z.object({ content: z.array(z.unknown()) }),
});

const ResultEvent = z.object({
  type: z.literal('result'),
  result: z.string().optional(),
  is_error: z.boolean().optional(),
  session_id: z.string().optional(),
  usage: z.unknown().optional(),
  structured_output: z.unknown().optional(),
});

const SessionEvent = z.object({
  session_id: z.string(),
});

const ApiRetryEvent = z.object({
  attempt: z.number(),
  max_retries: z.number(),
  retry_delay_ms: z.number(),
  error_status: z.number().nullable(),
  error: z.string(),
});

function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    const candidate = optionalString(value, { trim: true, nonEmpty: true });
    if (candidate) return candidate;
  }
  return undefined;
}

function parseStreamEvent(event: Record<string, unknown>): StreamParseResult | null {
  if (event.type !== 'stream_event' || !isRecord(event.event)) return null;
  const streamEvent = event.event;
  const sessionId = firstString(event.session_id, streamEvent.session_id);
  const streamType = firstString(streamEvent.type);

  if (streamType === 'content_block_delta' && isRecord(streamEvent.delta)) {
    const delta = streamEvent.delta;
    if (delta.type === 'text_delta') {
      // Payload text is read verbatim: `firstString` trims and drops
      // whitespace-only values, which is right for ids and discriminants and
      // silently corrupts a message whose slices break on a space or a
      // paragraph gap.
      const text = typeof delta.text === 'string' ? delta.text : undefined;
      return text
        ? { text, channel: 'assistant', textSemantics: 'delta', sessionId }
        : { sessionId };
    }
    if (delta.type === 'input_json_delta') {
      const inputDelta = typeof delta.partial_json === 'string' ? delta.partial_json : '';
      const index = streamEvent.index;
      return {
        sessionId,
        toolUseDelta: [
          {
            ...(typeof index === 'number' ? { id: `content-block-${index}` } : {}),
            inputDelta,
          },
        ],
      };
    }
  }

  if (streamType === 'content_block_start' && isRecord(streamEvent.content_block)) {
    const block = streamEvent.content_block;
    if (block.type === 'tool_use') {
      const name = firstString(block.name) ?? 'tool_use';
      const id = firstString(block.id);
      return {
        sessionId,
        toolUseStart: [
          {
            ...(id !== undefined && { id }),
            name,
            input: isRecord(block.input) ? block.input : {},
          },
        ],
      };
    }
  }

  if (streamType === 'message_start') return { sessionId, isMessageStart: true };

  if (streamType === 'message_delta') {
    const stopReason = isRecord(streamEvent.delta)
      ? firstString(streamEvent.delta.stop_reason)
      : undefined;
    const usage = isRecord(streamEvent.usage) ? toTokenDelta(streamEvent.usage) : null;
    return {
      sessionId,
      ...(usage && { usage, usageSemantics: 'cumulative' }),
      ...(stopReason !== undefined && { stopReason }),
    };
  }

  return { sessionId };
}

/** `overloaded (HTTP 529): retry 2 of 10 in 4.0s`, from the fields Claude Code documents. */
function apiRetryWarning(event: Record<string, unknown>): ParsedWarningInfo {
  const retry = ApiRetryEvent.safeParse(event);
  if (!retry.success) {
    return {
      code: 'claude_api_retry',
      severity: 'warning',
      message: 'retrying a failed API request',
    };
  }
  const { attempt, max_retries, retry_delay_ms, error_status, error } = retry.data;
  const status = error_status === null ? 'no HTTP response' : `HTTP ${error_status}`;
  return {
    code: 'claude_api_retry',
    severity: 'warning',
    message: `${error} (${status}): retry ${attempt} of ${max_retries} in ${formatDuration(retry_delay_ms)}`,
  };
}

/**
 * `claude-opus-5-5 → claude-opus-4-8 (refusal: cyber)`: the models and the cause Claude Code
 * names, short enough that an 80-column row keeps both models. With no cause, its own notice
 * gives the reason. The raw ids also ride along as structured fields, so a display layer that
 * knows the runner's catalog can spell those names without re-parsing the message.
 */
function modelFallbackWarning(event: Record<string, unknown>): ParsedWarningInfo {
  const from = firstString(event.original_model);
  const to = firstString(event.fallback_model);
  const cause = [firstString(event.trigger), firstString(event.api_refusal_category)]
    .filter((part) => part !== undefined)
    .join(': ');
  const notice = firstString(event.content);
  const models = from !== undefined && to !== undefined ? `${from} → ${to}` : 'switched model';
  const reason = cause !== '' ? ` (${cause})` : notice === undefined ? '' : `: ${notice}`;
  return {
    code: 'claude_fallback',
    severity: 'warning',
    message: `${models}${reason}`,
    ...(from !== undefined && { originalModel: from }),
    ...(to !== undefined && { fallbackModel: to }),
  };
}

/** A refusal with no model to fall back to; Claude Code sends it with an empty notice. */
function modelRefusalWarning(event: Record<string, unknown>): ParsedWarningInfo {
  const named = firstString(event.original_model);
  const model = named ?? 'the model';
  const category = firstString(event.api_refusal_category);
  const head = category === undefined ? `${model} refused` : `${model} refused (${category})`;
  const reason = firstString(event.api_refusal_explanation, event.content);
  return {
    code: 'claude_refusal',
    severity: 'error',
    message: `${head}: ${reason ?? 'no fallback model'}`,
    ...(named !== undefined && { originalModel: named }),
  };
}

function permissionDeniedWarning(event: Record<string, unknown>): ParsedWarningInfo {
  const tool = firstString(event.tool_name) ?? 'a tool';
  const decidedBy = firstString(event.decision_reason_type);
  const head = decidedBy === undefined ? `${tool} denied` : `${tool} denied (${decidedBy})`;
  const reason = firstString(event.decision_reason, event.message);
  return {
    code: 'claude_permission_denied',
    severity: 'warning',
    message: reason === undefined ? head : `${head}: ${reason}`,
  };
}

function noticeWarning(
  text: unknown,
  severity: 'warning' | 'error' = 'warning',
): ParsedWarningInfo | null {
  const message = firstString(text);
  return message === undefined ? null : { code: 'claude_notice', severity, message };
}

/**
 * The `system` frames a headless operator needs: a request Claude Code retries, a model it
 * swapped or that refused, a tool call it denied, a notification it colours as a warning or an
 * error (in stream-json mode Claude Code sends its own terminal warnings this way, such as the
 * effort cap), and an informational banner at `warning` level. The frame keeps the severity its
 * activity row is coloured by: a refusal with no fallback and an error-coloured notification
 * are errors, while a retry, a fallback, a denial and a `warning`-level banner stay warnings.
 * A `notice` banner (hook feedback is one), like an `info` or `suggestion` banner and every
 * other frame, is below the warning channel and is bookkeeping.
 */
function systemFrameWarning(
  subtype: string | undefined,
  event: Record<string, unknown>,
): ParsedWarningInfo | null {
  switch (subtype) {
    case 'api_retry':
      return apiRetryWarning(event);
    case 'model_fallback':
    case 'model_consent_fallback':
    case 'model_refusal_fallback':
      return modelFallbackWarning(event);
    case 'model_refusal_no_fallback':
      return modelRefusalWarning(event);
    case 'permission_denied':
      return permissionDeniedWarning(event);
    case 'notification':
      return event.color === 'warning' || event.color === 'error'
        ? noticeWarning(event.text, event.color === 'error' ? 'error' : 'warning')
        : null;
    case 'informational':
      return event.level === 'warning' ? noticeWarning(event.content, 'warning') : null;
    default:
      return null;
  }
}

/**
 * A `system` frame is never text. One the operator needs becomes a warning; the rest — init,
 * hooks, status, thinking-token estimates, background tasks — are Claude Code's own bookkeeping,
 * a heartbeat that keeps a thinking seat from reading as silent.
 */
function parseSystemProgress(event: Record<string, unknown>): StreamParseResult | null {
  const type = firstString(event.type);
  if (!type) return null;
  const sessionId = firstString(event.session_id);
  if (type === 'system') {
    const subtype = firstString(event.subtype);
    const warning = systemFrameWarning(subtype, event);
    return {
      sessionId,
      ...(subtype === 'init' && { isSessionInit: true }),
      ...(warning === null ? { isHeartbeat: true } : { warning: [warning] }),
    };
  }
  if (type === 'api_error') {
    return {
      sessionId,
      warning: [
        {
          code: 'claude_api_error',
          severity: 'warning',
          message: firstString(event.message) ?? type,
        },
      ],
    };
  }
  if (type === 'api_retry' || type === 'plugin_progress') return { sessionId, isHeartbeat: true };
  return null;
}

/**
 * A top-level `rate_limit_event`. `allowed` is the steady state, and `overageStatus` can stay
 * `rejected` while `status` is `allowed`; only an approaching or rejected limit is news.
 * Unknown and missing statuses stay telemetry, so the parser never invents a limit.
 */
function parseRateLimitEvent(event: Record<string, unknown>): StreamParseResult | null {
  if (firstString(event.type) !== 'rate_limit_event') return null;
  const sessionId = firstString(event.session_id);
  const info = isRecord(event.rate_limit_info) ? event.rate_limit_info : null;
  const status = info === null ? undefined : firstString(info.status);
  if (info !== null && (status === 'allowed_warning' || status === 'rejected')) {
    return { sessionId, warning: [rateLimitWarning(status, info)] };
  }
  return { sessionId, isHeartbeat: true };
}

/**
 * `seven_day rate limit approaching (resets Nov 3, 16:30)`: the limit type and its
 * reset when the frame names them, and a shorter clause when it does not.
 */
function rateLimitWarning(
  status: 'allowed_warning' | 'rejected',
  info: Record<string, unknown>,
): ParsedWarningInfo {
  const type = firstString(info.rateLimitType);
  const reached = status === 'rejected';
  const reset = rateLimitResetLabel(info.resetsAt);
  const state = reached ? 'reached' : 'approaching';
  const head = type === undefined ? 'rate limit' : `${type} rate limit`;
  return {
    code: 'claude_rate_limit',
    severity: reached ? 'error' : 'warning',
    message: reset === undefined ? `${head} ${state}` : `${head} ${state} (resets ${reset})`,
  };
}

/** `resetsAt` is epoch seconds; a value the runtime cannot read drops the reset clause. */
function rateLimitResetLabel(value: unknown): string | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
  const resetsAt = new Date(value * 1000);
  return Number.isNaN(resetsAt.getTime()) ? undefined : formatStoredReset(resetsAt.getTime());
}

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

function parseLine(
  line: string,
  collectUsage?: CollectMessageUsage,
  openTools?: OpenTools,
): StreamParseResult {
  if (!line.trim()) return EMPTY_RESULT;

  try {
    const event: unknown = JSON.parse(line);
    const record = isRecord(event) ? event : null;
    const usage = record === null ? undefined : collectUsage?.(record);
    const isSubagent = record?.parent_tool_use_id != null;

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
        ...(isSubagent && { isSubagent }),
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
    if (echo.success) return { inputAck: echo.data.message.content };

    const user = UserEvent.safeParse(event);
    if (user.success) {
      const closed = closedTools(user.data.message.content, openTools);
      if (closed.length > 0) {
        return {
          sessionId: user.data.session_id ?? undefined,
          toolUse: closed,
          ...(isSubagent && { isSubagent }),
        };
      }
    }

    if (record) {
      const streamEvent = parseStreamEvent(record);
      if (streamEvent) {
        rememberTools(openTools, streamEvent.toolUseStart ?? []);
        const scoped = isSubagent ? { ...streamEvent, isSubagent } : streamEvent;
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
