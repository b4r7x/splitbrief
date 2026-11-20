import type { z } from 'zod';
import type {
  TypedOutputCapability,
  TypedOutputTransport,
} from '../../core/runners/cli-tool/types.js';
import type { ActiveRunnerRole } from '../../core/runners/seat-roles.js';
import { type AppError, error, matches } from '../../utils/error.js';
import { redactSecrets } from '../../utils/redact/secrets.js';
import type { RunnerCallResult } from '../calls/types.js';
import { requireCompletedCall } from '../planners/require-completed-call.js';
import { inputTooLargeRefusal, type PromptLimit } from './input-limit.js';
import { isStrictJsonSchema } from './strict-json-schema.js';
import { countNoun } from '../../utils/pluralize.js';
import { extractLastJsonObject, type JsonExtraction } from './extract-json.js';

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
  /** Largest prompt the seat's tool accepts; omitted when the tool has no limit. */
  promptLimit?: PromptLimit | undefined;
  invoke: (input: {
    prompt: string;
    schema?: TypedSchemaInput | undefined;
  }) => Promise<RunnerCallResult>;
}>;

export type SeatProtocolErrorData = Readonly<{
  seat: ActiveRunnerRole;
  attempts: 1 | 2;
  transport: TypedOutputTransport;
  errors: readonly string[];
  answerPreview: string;
}>;

export type SeatProtocolError = AppError<'seat-protocol-error', SeatProtocolErrorData>;

type TypedRequestInput = Readonly<{ prompt: string; call: TypedSeatCall }>;

export type RequestTypedOptions<T> = Readonly<{
  schema: z.ZodType<T>;
  jsonSchema: Readonly<Record<string, unknown>>;
  schemaName: string;
  /** Hears, before the seat is asked again, the reasons its first answer was refused. */
  onRepair?: ((reasons: readonly string[]) => void) | undefined;
}> &
  (TypedRequestInput | Readonly<{ prepareCall: () => Promise<TypedRequestInput> }>);

export type RequestTypedResult<T> =
  | Readonly<{ value: T; nativeSessionId: string | null }>
  | Readonly<{ error: SeatProtocolError }>;

const ANSWER_PREVIEW_MAX_LENGTH = 2000;

export function fallbackInstruction(jsonSchema: Readonly<Record<string, unknown>>): string {
  return `\n\nReply with exactly one JSON object that matches this schema: ${JSON.stringify(jsonSchema)}. No prose after it.`;
}

function resumeRepairPrompt(errors: readonly string[]): string {
  return `Your previous answer failed validation:\n${errors.join('\n')}\n\nReply again with exactly one JSON object that matches the schema.`;
}

function freshRepairPrompt(prompt: string, answer: string, errors: readonly string[]): string {
  return `${prompt}\n\nYour previous answer:\n${answer}\n\nIt failed validation:\n${errors.join('\n')}\n\nReply with exactly one JSON object that matches the schema.`;
}

function closeSentence(text: string): string {
  return /[.!?]$/.test(text) ? text : `${text}.`;
}

export function seatProtocolHeadline(
  data: Pick<SeatProtocolErrorData, 'seat' | 'attempts'>,
): string {
  return `The ${data.seat} seat answer did not match its contract after ${countNoun(data.attempts, 'attempt')}.`;
}

export const typedOutputError = {
  isSeatProtocol: (err: unknown): err is SeatProtocolError => matches('seat-protocol-error')(err),
  seatProtocol: (data: SeatProtocolErrorData): SeatProtocolError => {
    const headline = seatProtocolHeadline(data);
    const message =
      data.errors.length === 0
        ? headline
        : `${headline} ${data.errors.map(closeSentence).join(' ')}`;
    return error('seat-protocol-error', message, data);
  },
} as const;

const EXTRACTION_ERRORS: Readonly<Record<Exclude<JsonExtraction['kind'], 'ok'>, string>> = {
  none: 'No JSON object found in the answer.',
  invalid: 'The last JSON object in the answer is not valid JSON.',
  ambiguous: 'Ambiguous answer: several JSON objects end the reply; send exactly one.',
  truncated:
    'The JSON object in the answer is truncated: it never closes. Send the complete object.',
};

/** `errors` go back to the seat and into the halt; `reasons` say the same in a user's words. */
type AnswerFailure = Readonly<{
  errors: readonly string[];
  reasons: readonly string[];
  answer: string;
}>;

type CheckedAnswer<T> =
  | Readonly<{ ok: true; value: T }>
  | (Readonly<{ ok: false }> & AnswerFailure);

// A field is named by its own key, the one nearest the problem: list positions and the path
// above it are the contract's wiring, not words a user reads.
function issueReasons(issues: readonly z.core.$ZodIssue[]): string[] {
  const rules = issues
    .filter((issue) => issue.path.length === 0)
    .map((issue) => closeSentence(issue.message));
  const fields = [
    ...new Set(
      issues.flatMap((issue) => {
        const key = issue.path.findLast((segment) => typeof segment === 'string');
        return typeof key === 'string' ? [key] : [];
      }),
    ),
  ];
  return [
    ...rules,
    ...(fields.length > 0 ? [`Wrong or missing value in ${fields.join(', ')}.`] : []),
  ];
}

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
      const reason = EXTRACTION_ERRORS[extracted.kind];
      return { ok: false, errors: [reason], reasons: [reason], answer: result.text };
    }
    candidate = extracted.value;
    answer = result.text;
  }
  const parsed = schema.safeParse(candidate);
  if (!parsed.success) {
    const errors = parsed.error.issues.map((issue) => {
      const path = issue.path.join('.');
      return path.length === 0 ? issue.message : `${path}: ${issue.message}`;
    });
    return { ok: false, errors, reasons: issueReasons(parsed.error.issues), answer };
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

function transportFor(
  capability: TypedOutputCapability,
  jsonSchema: Readonly<Record<string, unknown>>,
): TypedOutputTransport {
  if (capability !== 'strict-native') return capability;
  return isStrictJsonSchema(jsonSchema) ? 'native' : 'fallback';
}

/** The text a typed call appends to its prompt: the answer schema, unless the tool takes it natively. */
export function typedPromptSuffix(
  capability: TypedOutputCapability,
  jsonSchema: Readonly<Record<string, unknown>>,
): string {
  return transportFor(capability, jsonSchema) === 'native' ? '' : fallbackInstruction(jsonSchema);
}

function refuseOverLimit(prompt: string, limit: PromptLimit | undefined): void {
  if (limit === undefined) return;
  if (prompt.length > limit.max) throw inputTooLargeRefusal(prompt.length, limit);
}

export async function requestTyped<T>(
  opts: RequestTypedOptions<T>,
): Promise<RequestTypedResult<T>> {
  const prepareCall = 'prepareCall' in opts ? opts.prepareCall : async () => opts;
  const input = await prepareCall();
  const { seat } = input.call;
  const transport = transportFor(input.call.typedOutput, opts.jsonSchema);
  const schemaInput: TypedSchemaInput = { json: opts.jsonSchema, name: opts.schemaName };
  const suffix = typedPromptSuffix(input.call.typedOutput, opts.jsonSchema);
  const firstPrompt = input.prompt + suffix;

  // A continuation prompt the caller built, and the repair prompt below, can both
  // grow past what the seat's tool accepts. Refuse before sending so the halt is
  // classified from the prompt size, not from a tool that never saw the call.
  refuseOverLimit(firstPrompt, input.call.promptLimit);

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
    };
  }

  if (seat === 'implementer') {
    return {
      error: seatProtocolError(seat, 1, transport, firstCheck),
    };
  }

  const continuesThread =
    seat === 'planner' && input.call.canResume && first.nativeSessionId !== null;
  const repairInput = await prepareCall();
  const repairPrompt = continuesThread
    ? resumeRepairPrompt(firstCheck.errors)
    : freshRepairPrompt(repairInput.prompt, firstCheck.answer, firstCheck.errors);
  const repairPromptSent = repairPrompt + suffix;
  refuseOverLimit(repairPromptSent, repairInput.call.promptLimit);
  opts.onRepair?.(firstCheck.reasons);
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
    };
  }
  return {
    error: seatProtocolError(seat, 2, transport, repairCheck),
  };
}
