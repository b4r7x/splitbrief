import { z } from 'zod';
import type {
  TypedOutputCapability,
  TypedOutputTransport,
} from '../../core/runners/cli-tool-catalog.js';
import type { ActiveRunnerRole } from '../../core/runners/seat-roles.js';
import type { TokenDelta } from '../../core/schemas/tokens.js';
import { type AppError, error, matches } from '../../utils/error.js';
import { redactSecrets } from '../../utils/redact.js';
import { isRecord } from '../../utils/type-guards.js';
import { toTokenDelta } from '../calls/projection.js';
import { accumulateTokenUsage } from '../calls/usage.js';
import type { RunnerCallResult } from '../calls/types.js';
import { requireCompletedCall } from '../planners/require-completed-call.js';
import { inputTooLargeRefusal } from './input-limit.js';
import { isStrictJsonSchema } from './strict-json-schema.js';

export type TypedSchemaInput = Readonly<{
  json: Readonly<Record<string, unknown>>;
  name: string;
}>;

/**
 * A planner binding runs every call on the planner's own planning thread, so a repair on a tool
 * that can resume continues the thread that gave the answer. A review call holds no session.
 */
export type TypedSeatCall = Readonly<{
  seat: ActiveRunnerRole;
  typedOutput: TypedOutputCapability;
  canResume: boolean;
  /** Largest prompt the seat's tool accepts in characters; omitted when the tool has no cap. */
  maxInputChars?: number | undefined;
  invoke: (input: {
    prompt: string;
    schema?: TypedSchemaInput | undefined;
  }) => Promise<RunnerCallResult>;
}>;

type SeatProtocolErrorData = Readonly<{
  seat: ActiveRunnerRole;
  attempts: 1 | 2;
  transport: TypedOutputTransport;
  errors: string;
  answerPreview: string;
}>;

export type SeatProtocolError = AppError<'seat-protocol-error', SeatProtocolErrorData>;

type TypedRequestInput = Readonly<{ prompt: string; call: TypedSeatCall }>;

export type RequestTypedOptions<T> = Readonly<{
  schema: z.ZodType<T>;
  jsonSchema: Readonly<Record<string, unknown>>;
  schemaName: string;
}> &
  (TypedRequestInput | Readonly<{ prepareCall: () => Promise<TypedRequestInput> }>);

export type RequestTypedResult<T> =
  | Readonly<{ value: T; nativeSessionId: string | null; usage: TokenDelta | null }>
  | Readonly<{ error: SeatProtocolError; usage: TokenDelta | null }>;

type JsonExtraction =
  | Readonly<{ kind: 'ok'; value: unknown }>
  | Readonly<{ kind: 'none' }>
  | Readonly<{ kind: 'invalid' }>
  | Readonly<{ kind: 'ambiguous' }>
  | Readonly<{ kind: 'truncated' }>;

const ANSWER_PREVIEW_MAX_LENGTH = 2000;

export function fallbackInstruction(jsonSchema: Readonly<Record<string, unknown>>): string {
  return `\n\nReply with exactly one JSON object that matches this schema: ${JSON.stringify(jsonSchema)}. No prose after it.`;
}

function resumeRepairPrompt(errors: string): string {
  return `Your previous answer failed validation:\n${errors}\n\nReply again with exactly one JSON object that matches the schema.`;
}

function freshRepairPrompt(prompt: string, answer: string, errors: string): string {
  return `${prompt}\n\nYour previous answer:\n${answer}\n\nIt failed validation:\n${errors}\n\nReply with exactly one JSON object that matches the schema.`;
}

export const typedOutputError = {
  isSeatProtocol: (err: unknown): err is SeatProtocolError => matches('seat-protocol-error')(err),
  seatProtocol: (data: SeatProtocolErrorData): SeatProtocolError =>
    error(
      'seat-protocol-error',
      `The ${data.seat} seat answer did not match its contract after ${data.attempts} attempt(s).`,
      data,
    ),
} as const;

const FENCE = /```[\w-]*[ \t]*\n([\s\S]*?)\n```/g;
const JSON_OPENING = /^\s*\{\s*("|\})/;

/** The end of the object that opens at `start`, string-aware; undefined when it never closes. */
function objectEnd(text: string, start: number): number | undefined {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
    } else if (ch === '"') {
      inString = true;
    } else if (ch === '{') {
      depth++;
    } else if (ch === '}') {
      depth--;
      if (depth === 0) return i + 1;
    }
  }
  return undefined;
}

const CUT = -1;
const BAD = -2;
const FIRST_KEY = /^\{\s*"(?:[^"\\]|\\.)*"\s*:/;
const LITERAL = /^(?:true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)$/;
const NUMBER_PREFIX = /^-?$|^-?(?:0|[1-9]\d*)(?:\.|\.\d+(?:[eE][+-]?\d*)?|[eE][+-]?\d*)?$/;

function isLiteralPrefix(token: string): boolean {
  return (
    ['true', 'false', 'null'].some((word) => word.startsWith(token)) || NUMBER_PREFIX.test(token)
  );
}

function skipSpace(text: string, i: number): number {
  let at = i;
  while (at < text.length && ' \t\n\r'.includes(text.charAt(at))) at++;
  return at;
}

/** The end of the JSON value at `i`; CUT when the text ends inside it, BAD when it is not JSON. */
function scanValue(text: string, i: number): number {
  const at = skipSpace(text, i);
  if (at >= text.length) return CUT;
  const ch = text[at];
  if (ch === '{') return scanContainer(text, at, '}');
  if (ch === '[') return scanContainer(text, at, ']');
  if (ch === '"') return scanString(text, at);
  let end = at;
  while (end < text.length && /[\w.+-]/.test(text.charAt(end))) end++;
  if (end >= text.length) return isLiteralPrefix(text.slice(at)) ? CUT : BAD;
  return LITERAL.test(text.slice(at, end)) ? end : BAD;
}

function scanString(text: string, i: number): number {
  for (let at = i + 1; at < text.length; at++) {
    if (text[at] === '\\') at++;
    else if (text[at] === '"') return at + 1;
  }
  return CUT;
}

function scanContainer(text: string, i: number, close: '}' | ']'): number {
  let at = skipSpace(text, i + 1);
  if (at >= text.length) return CUT;
  if (text[at] === close) return at + 1;
  for (;;) {
    if (close === '}') {
      if (text[at] !== '"') return BAD;
      at = scanString(text, at);
      if (at < 0) return at;
      at = skipSpace(text, at);
      if (at >= text.length) return CUT;
      if (text[at] !== ':') return BAD;
      at++;
    }
    at = scanValue(text, at);
    if (at < 0) return at;
    at = skipSpace(text, at);
    if (at >= text.length) return CUT;
    if (text[at] === close) return at + 1;
    if (text[at] !== ',') return BAD;
    at = skipSpace(text, at + 1);
    if (at >= text.length) return CUT;
  }
}

/**
 * An unclosed object is a truncated answer when it gets past its first key and everything up to
 * the end of the text is the start of valid JSON; `{"b" from the old shape` is prose.
 */
function isTruncatedObject(tail: string): boolean {
  return FIRST_KEY.test(tail) && scanValue(tail, 0) === CUT;
}

type Candidate = Readonly<{ start: number; end: number; body: string; bare: boolean }>;

function parseObject(body: string): Readonly<Record<string, unknown>> | undefined {
  try {
    const value: unknown = JSON.parse(body);
    return isRecord(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The answer is the object that parses and ends last, fenced or bare. A fence counts when
 * its body opens an object, and its contents never yield a bare object. A later brace span
 * that does not parse is skipped when it reads as prose (`{above}`); one that opens like
 * JSON is the malformed answer, never hidden by an earlier object. An object outside every
 * closed span that never closes and is a valid JSON prefix to the end: the answer is truncated.
 */
export function extractLastJsonObject(text: string): JsonExtraction {
  let unfenced = text;
  const candidates: Candidate[] = [];
  for (const match of text.matchAll(FENCE)) {
    const end = match.index + match[0].length;
    unfenced = unfenced.slice(0, match.index) + ' '.repeat(match[0].length) + unfenced.slice(end);
    const body = match[1] ?? '';
    if (body.trimStart().startsWith('{')) {
      candidates.push({ start: match.index, end, body, bare: false });
    }
  }
  let closedUntil = 0;
  for (let i = unfenced.indexOf('{'); i !== -1; i = unfenced.indexOf('{', i + 1)) {
    const end = objectEnd(unfenced, i);
    if (end !== undefined) {
      candidates.push({ start: i, end, body: text.slice(i, end), bare: true });
      closedUntil = Math.max(closedUntil, end);
    } else if (i >= closedUntil && isTruncatedObject(unfenced.slice(i))) {
      return { kind: 'truncated' };
    }
  }
  if (candidates.length === 0) return { kind: 'none' };

  candidates.sort((a, b) => b.end - a.end || a.start - b.start);
  for (const [index, last] of candidates.entries()) {
    const value = parseObject(last.body);
    if (value === undefined) {
      if (JSON_OPENING.test(last.body)) return { kind: 'invalid' };
      continue;
    }
    const adjacent =
      last.bare &&
      candidates
        .slice(index + 1)
        .some(
          (other) =>
            other.bare &&
            other.end <= last.start &&
            text.slice(other.end, last.start).trim() === '' &&
            parseObject(other.body) !== undefined,
        );
    return adjacent ? { kind: 'ambiguous' } : { kind: 'ok', value };
  }
  return { kind: 'invalid' };
}

const EXTRACTION_ERRORS: Readonly<Record<Exclude<JsonExtraction['kind'], 'ok'>, string>> = {
  none: 'No JSON object found in the answer.',
  invalid: 'The last JSON object in the answer is not valid JSON.',
  ambiguous: 'Ambiguous answer: several JSON objects end the reply; send exactly one.',
  truncated:
    'The JSON object in the answer is truncated: it never closes. Send the complete object.',
};

type AnswerFailure = Readonly<{ errors: string; answer: string }>;

type CheckedAnswer<T> =
  | Readonly<{ ok: true; value: T }>
  | Readonly<{ ok: false; errors: string; answer: string }>;

function checkAnswer<T>(schema: z.ZodType<T>, result: RunnerCallResult): CheckedAnswer<T> {
  const structured = result.status === 'completed' ? result.structured : undefined;
  let candidate: unknown;
  let answer: string;
  if (structured !== undefined) {
    candidate = structured;
    answer = JSON.stringify(structured);
  } else {
    const extracted = extractLastJsonObject(result.text);
    if (extracted.kind !== 'ok') {
      return { ok: false, errors: EXTRACTION_ERRORS[extracted.kind], answer: result.text };
    }
    candidate = extracted.value;
    answer = result.text;
  }
  const parsed = schema.safeParse(candidate);
  if (!parsed.success) {
    return { ok: false, errors: z.prettifyError(parsed.error), answer };
  }
  return { ok: true, value: parsed.data };
}

function seatProtocolError(
  seat: ActiveRunnerRole,
  attempts: 1 | 2,
  transport: TypedOutputTransport,
  failure: AnswerFailure,
): SeatProtocolError {
  return typedOutputError.seatProtocol({
    seat,
    attempts,
    transport,
    errors: failure.errors,
    answerPreview: redactSecrets(failure.answer).slice(0, ANSWER_PREVIEW_MAX_LENGTH),
  });
}

function totalUsage(first: RunnerCallResult, repair: RunnerCallResult): TokenDelta | null {
  const repairUsage = toTokenDelta(repair.usage);
  const firstUsage = toTokenDelta(first.usage);
  return repairUsage === null ? firstUsage : accumulateTokenUsage(firstUsage, repairUsage);
}

function transportFor(
  capability: TypedOutputCapability,
  jsonSchema: Readonly<Record<string, unknown>>,
): TypedOutputTransport {
  if (capability !== 'strict-native') return capability;
  return isStrictJsonSchema(jsonSchema) ? 'native' : 'fallback';
}

export async function requestTyped<T>(
  opts: RequestTypedOptions<T>,
): Promise<RequestTypedResult<T>> {
  const prepareCall = 'prepareCall' in opts ? opts.prepareCall : async () => opts;
  const input = await prepareCall();
  const { seat } = input.call;
  const transport = transportFor(input.call.typedOutput, opts.jsonSchema);
  const schemaInput: TypedSchemaInput = { json: opts.jsonSchema, name: opts.schemaName };
  const firstPrompt =
    transport === 'native' ? input.prompt : input.prompt + fallbackInstruction(opts.jsonSchema);
  const maxInputChars = input.call.maxInputChars;

  // A continuation prompt the caller built, and the repair prompt below, can both
  // grow past what the seat's tool accepts. Refuse before sending so the halt is
  // classified from the prompt size, not from a tool that never saw the call.
  if (maxInputChars !== undefined && firstPrompt.length > maxInputChars) {
    throw inputTooLargeRefusal(firstPrompt.length, maxInputChars);
  }

  const first = requireCompletedCall(
    await input.call.invoke({
      prompt: firstPrompt,
      ...(transport === 'native' && { schema: schemaInput }),
    }),
  );
  const firstCheck = checkAnswer(opts.schema, first);
  if (firstCheck.ok) {
    return {
      value: firstCheck.value,
      nativeSessionId: first.nativeSessionId,
      usage: toTokenDelta(first.usage),
    };
  }

  if (seat === 'implementer') {
    return {
      error: seatProtocolError(seat, 1, transport, firstCheck),
      usage: toTokenDelta(first.usage),
    };
  }

  const continuesThread =
    seat === 'planner' && input.call.canResume && first.nativeSessionId !== null;
  const repairInput = await prepareCall();
  const repairPrompt = continuesThread
    ? resumeRepairPrompt(firstCheck.errors)
    : freshRepairPrompt(repairInput.prompt, firstCheck.answer, firstCheck.errors);
  const repairPromptSent =
    transport === 'fallback' ? repairPrompt + fallbackInstruction(opts.jsonSchema) : repairPrompt;
  const repairMaxInputChars = repairInput.call.maxInputChars;
  if (repairMaxInputChars !== undefined && repairPromptSent.length > repairMaxInputChars) {
    throw inputTooLargeRefusal(repairPromptSent.length, repairMaxInputChars);
  }
  const repair = requireCompletedCall(
    await repairInput.call.invoke({
      prompt: repairPromptSent,
      ...(transport === 'native' && { schema: schemaInput }),
    }),
  );
  const repairCheck = checkAnswer(opts.schema, repair);
  if (repairCheck.ok) {
    return {
      value: repairCheck.value,
      nativeSessionId: repair.nativeSessionId,
      usage: totalUsage(first, repair),
    };
  }
  return {
    error: seatProtocolError(seat, 2, transport, repairCheck),
    usage: totalUsage(first, repair),
  };
}
