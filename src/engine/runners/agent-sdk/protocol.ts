import { z } from 'zod';
import { isRecord } from '../../../utils/type-guards.js';

const SdkTextBlockSchema = z.looseObject({
  type: z.literal('text'),
  text: z.string(),
});

const SdkToolUseBlockSchema = z.looseObject({
  type: z.literal('tool_use'),
  id: z.string().optional(),
  tool_use_id: z.string().optional(),
  name: z.string(),
  input: z.unknown().optional(),
});

const SdkSystemMessageSchema = z.looseObject({
  type: z.literal('system'),
  subtype: z.string().optional(),
  session_id: z.string().optional(),
});

const SdkAssistantMessageSchema = z.looseObject({
  type: z.literal('assistant'),
  message: z
    .looseObject({
      content: z.array(z.unknown()).optional(),
    })
    .optional(),
});

const SdkResultMessageSchema = z.looseObject({
  type: z.literal('result'),
  subtype: z.string().optional(),
  session_id: z.string().optional(),
  result: z.string().optional(),
  is_error: z.boolean().optional(),
  errors: z.array(z.string()).optional(),
  terminal_reason: z.string().nullable().optional(),
  usage: z
    .looseObject({
      input_tokens: z.number(),
      output_tokens: z.number(),
    })
    .optional(),
});

const SdkStreamEventMessageSchema = z.looseObject({
  type: z.literal('stream_event'),
});

const SdkMessageSchema = z.discriminatedUnion('type', [
  SdkSystemMessageSchema,
  SdkAssistantMessageSchema,
  SdkResultMessageSchema,
  SdkStreamEventMessageSchema,
]);

export type SdkMessage = z.infer<typeof SdkMessageSchema>;

export type SdkDecodeResult = z.ZodSafeParseResult<SdkMessage>;

export function decodeSdkMessage(raw: unknown): SdkDecodeResult {
  return SdkMessageSchema.safeParse(raw);
}

export { SdkTextBlockSchema, SdkToolUseBlockSchema };

export function blockType(value: unknown): string | undefined {
  return isRecord(value) && typeof value.type === 'string' ? value.type : undefined;
}

export function extractResultText(message: Extract<SdkMessage, { type: 'result' }>): string {
  if (typeof message.result === 'string') return message.result;
  return '';
}

export function isSdkResultFailure(message: Extract<SdkMessage, { type: 'result' }>): boolean {
  if (message.type !== 'result') return false;
  if (message.is_error === true) return true;
  return message.subtype !== undefined && message.subtype !== 'success';
}

export type RunnerCallFailureStatus = 'aborted' | 'truncated' | 'failed';

export function sdkFailureStatus(
  message: Extract<SdkMessage, { type: 'result' }>,
): RunnerCallFailureStatus {
  if (
    message.terminal_reason === 'aborted_streaming' ||
    message.terminal_reason === 'aborted_tools'
  ) {
    return 'aborted';
  }
  if (message.subtype === 'error_max_turns') return 'truncated';
  return 'failed';
}

export function sdkResultErrorMessage(message: Extract<SdkMessage, { type: 'result' }>): string {
  if (message.errors && message.errors.length > 0) return message.errors.join('\n');
  const resultText = extractResultText(message);
  if (resultText) return resultText;
  if (message.subtype) return `Agent SDK result subtype ${message.subtype}`;
  return 'Agent SDK result failed';
}
