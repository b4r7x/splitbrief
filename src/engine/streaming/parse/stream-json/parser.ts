import type { TokenDelta } from '../../../../core/schemas/tokens.js';
import { isRecord } from '../../../../utils/type-guards.js';
import { accumulateTokenUsage } from '../../../calls/usage/accumulate.js';
import { BackendTokenUsageSchema, toTokenDelta } from '../../../calls/usage/normalize.js';
import { parseLine } from './line.js';
import { firstString } from './events.js';
import type { StreamParseResult, MessageUsage, OpenTools, CollectMessageUsage } from './result.js';

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
