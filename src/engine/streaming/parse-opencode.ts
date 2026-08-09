import { z } from 'zod';
import { isRecord } from '../../utils/type-guards.js';
import type { ParsedLine } from '../runners/types.js';
import { parsedMalformedRecordWarning, parsedUnknownRecordWarning } from './parser-warnings.js';

const OpencodeBaseEvent = z.looseObject({
  sessionID: z.string().optional(),
  sessionId: z.string().optional(),
});

const OpencodeTextEvent = z.object({
  type: z.literal('text'),
  part: z.object({
    type: z.literal('text'),
    text: z.string(),
  }),
});

const OpencodeStepFinishEvent = z.object({
  type: z.literal('step_finish'),
  part: z.object({
    type: z.literal('step-finish'),
    tokens: z.object({
      input: z.number(),
      output: z.number(),
      reasoning: z.number().optional(),
      cache: z
        .object({
          read: z.number().optional(),
          write: z.number().optional(),
        })
        .optional(),
    }),
  }),
});

// Real opencode tool parts nest the call payload under `state`:
// { part: { type: 'tool', tool: 'read', callID: 'read_0',
//   state: { status: 'completed', input: {...}, output: '...', ... } } }.
const OpencodeToolStateSchema = z.looseObject({
  status: z.string().optional(),
  input: z.record(z.string(), z.unknown()).optional(),
  output: z.unknown().optional(),
});

const OpencodeToolEvent = z.object({
  type: z.enum(['tool_use', 'tool_call', 'tool', 'tool_start', 'tool_finish', 'tool_result']),
  part: z.looseObject({
    type: z.string().optional(),
    id: z.string().optional(),
    callID: z.string().optional(),
    name: z.string().optional(),
    tool: z.string().optional(),
    state: z.union([OpencodeToolStateSchema, z.string()]).optional(),
    status: z.string().optional(),
    input: z.record(z.string(), z.unknown()).optional(),
    args: z.record(z.string(), z.unknown()).optional(),
    output: z.unknown().optional(),
    result: z.unknown().optional(),
  }),
});

function withSession(result: ParsedLine, event: unknown): ParsedLine {
  const base = OpencodeBaseEvent.safeParse(event);
  if (!base.success) return result;
  const sessionId = base.data.sessionID ?? base.data.sessionId;
  return sessionId ? { ...result, sessionId } : result;
}

export function parseOpencodeLine(line: string): ParsedLine {
  const trimmed = line.trim();
  if (!trimmed) return {};

  let event: unknown;
  try {
    event = JSON.parse(trimmed);
  } catch {
    // The raw line can carry tool payloads (file contents, command output), so
    // the warning gets a length descriptor instead of the line itself.
    return {
      warning: [
        parsedMalformedRecordWarning({
          parser: 'opencode',
          line: `[unparseable opencode line: ${trimmed.length} chars]`,
          message: 'Malformed opencode JSON line skipped',
        }),
      ],
    };
  }

  const text = OpencodeTextEvent.safeParse(event);
  if (text.success) return withSession({ text: text.data.part.text, channel: 'assistant' }, event);

  const step = OpencodeStepFinishEvent.safeParse(event);
  if (step.success) {
    const { tokens } = step.data.part;
    return withSession(
      {
        usage: {
          inputTokens: tokens.input,
          outputTokens: tokens.output,
          ...(tokens.reasoning !== undefined && { reasoningTokens: tokens.reasoning }),
          ...(tokens.cache?.read !== undefined && { cacheReadTokens: tokens.cache.read }),
          ...(tokens.cache?.write !== undefined && { cacheCreateTokens: tokens.cache.write }),
        },
      },
      event,
    );
  }

  const tool = OpencodeToolEvent.safeParse(event);
  if (tool.success) {
    const part = tool.data.part;
    const state = typeof part.state === 'string' ? undefined : part.state;
    const name = part.name ?? part.tool;
    if (name) {
      const id = part.callID ?? part.id;
      const output = state?.output ?? part.output ?? part.result;
      const toolUse = {
        ...(id !== undefined && { id }),
        name,
        input: state?.input ?? part.input ?? part.args ?? {},
        ...(output !== undefined && { output }),
      };
      const stateStatus = typeof part.state === 'string' ? part.state : state?.status;
      const isDone =
        tool.data.type === 'tool_finish' ||
        tool.data.type === 'tool_result' ||
        stateStatus === 'completed' ||
        part.status === 'completed' ||
        part.status === 'done';
      return withSession(isDone ? { toolUseDone: [toolUse] } : { toolUseStart: [toolUse] }, event);
    }
  }

  const warning = parsedUnknownRecordWarning({
    parser: 'opencode',
    value: summarizeUnknownOpencodeRecord(event),
    benign: isBenignOpencodeEvent(event),
  });
  return withSession(warning === null ? {} : { warning: [warning] }, event);
}

const SUMMARY_MAX_KEYS = 16;
const SUMMARY_MAX_TOKEN_CHARS = 64;

function summaryToken(value: unknown): string | undefined {
  return typeof value === 'string' ? value.slice(0, SUMMARY_MAX_TOKEN_CHARS) : undefined;
}

function summaryKeys(record: Record<string, unknown>): string[] {
  return Object.keys(record)
    .slice(0, SUMMARY_MAX_KEYS)
    .map((key) => key.slice(0, SUMMARY_MAX_TOKEN_CHARS));
}

// Structure-only summary for records the schema rejects: field names plus the
// short type/tool/status identifiers, never field values, so a warning can
// diagnose the shape without leaking tool payloads (file contents, command
// output) into event streams and logs.
function summarizeUnknownOpencodeRecord(event: unknown): Record<string, unknown> {
  if (!isRecord(event)) return { kind: typeof event };
  const summary: Record<string, unknown> = {};
  const type = summaryToken(event['type']);
  if (type !== undefined) summary['type'] = type;
  summary['keys'] = summaryKeys(event);
  const part = event['part'];
  if (isRecord(part)) {
    const partSummary: Record<string, unknown> = { keys: summaryKeys(part) };
    const partType = summaryToken(part['type']);
    if (partType !== undefined) partSummary['type'] = partType;
    const tool = summaryToken(part['tool'] ?? part['name']);
    if (tool !== undefined) partSummary['tool'] = tool;
    const state = part['state'];
    if (isRecord(state)) {
      const status = summaryToken(state['status']);
      partSummary['state'] = {
        ...(status !== undefined && { status }),
        keys: summaryKeys(state),
      };
    }
    summary['part'] = partSummary;
  }
  return summary;
}

function isBenignOpencodeEvent(event: unknown): boolean {
  const parsed = z
    .looseObject({
      type: z.enum(['step_start', 'step-start']),
    })
    .safeParse(event);
  return parsed.success;
}
