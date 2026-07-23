import { z } from 'zod';
import type { ChatCompletionChunk } from 'openai/resources/chat/completions';
import { runnerCallUnknownUpstreamPreview } from '../../calls/unknown-upstream.js';
import type { RunnerCallRecorder } from '../../calls/recorder.js';

export const StreamFunctionCallDeltaSchema = z.looseObject({
  name: z.string().optional(),
  arguments: z.string().optional(),
});

export const StreamToolCallDeltaSchema = z.looseObject({
  id: z.string().optional(),
  function: StreamFunctionCallDeltaSchema.optional(),
});

export const StreamChoiceDeltaSchema = z.looseObject({
  content: z.string().nullable().optional(),
  function_call: StreamFunctionCallDeltaSchema.optional(),
  tool_calls: z.array(StreamToolCallDeltaSchema).optional(),
});

export const StreamChoiceSchema = z.looseObject({
  delta: StreamChoiceDeltaSchema.optional(),
  finish_reason: z.string().nullable().optional(),
});

export const StreamUsageSchema = z
  .looseObject({
    prompt_tokens: z.number().nullable().optional(),
    completion_tokens: z.number().nullable().optional(),
    prompt_tokens_details: z
      .looseObject({
        cached_tokens: z.number().nullable().optional(),
      })
      .nullable()
      .optional(),
    completion_tokens_details: z
      .looseObject({
        reasoning_tokens: z.number().nullable().optional(),
      })
      .nullable()
      .optional(),
  })
  .nullable();

export const StreamChunkSchema = z.looseObject({
  choices: z.array(StreamChoiceSchema),
  usage: StreamUsageSchema.optional(),
});

export type StreamChoiceDelta = z.infer<typeof StreamChoiceDeltaSchema>;
export type StreamChunk = z.infer<typeof StreamChunkSchema>;

type OpenAiChoice = ChatCompletionChunk['choices'][number];
type OpenAiFunctionCallDelta = NonNullable<OpenAiChoice['delta']['function_call']>;
type OpenAiToolCallDelta = NonNullable<OpenAiChoice['delta']['tool_calls']>[number];

function toStreamFunctionCallDelta(
  value: OpenAiFunctionCallDelta,
): z.infer<typeof StreamFunctionCallDeltaSchema> {
  return {
    ...(value.name !== undefined && { name: value.name }),
    ...(value.arguments !== undefined && { arguments: value.arguments }),
  };
}

function toStreamToolCallDelta(
  value: OpenAiToolCallDelta,
): z.infer<typeof StreamToolCallDeltaSchema> {
  return {
    ...(value.id !== undefined && { id: value.id }),
    ...(value.function !== undefined && { function: toStreamFunctionCallDelta(value.function) }),
  };
}

export function toStreamChunk(chunk: ChatCompletionChunk): StreamChunk {
  return {
    choices: chunk.choices.map((choice) => ({
      delta: {
        ...(choice.delta.content === undefined ? {} : { content: choice.delta.content }),
        ...(choice.delta.function_call === undefined
          ? {}
          : { function_call: toStreamFunctionCallDelta(choice.delta.function_call) }),
        ...(choice.delta.tool_calls === undefined
          ? {}
          : { tool_calls: choice.delta.tool_calls.map(toStreamToolCallDelta) }),
      },
      ...(choice.finish_reason != null && { finish_reason: choice.finish_reason }),
    })),
    usage: chunk.usage
      ? {
          prompt_tokens: chunk.usage.prompt_tokens,
          completion_tokens: chunk.usage.completion_tokens,
          ...(chunk.usage.prompt_tokens_details && {
            prompt_tokens_details: {
              ...(chunk.usage.prompt_tokens_details.cached_tokens !== undefined && {
                cached_tokens: chunk.usage.prompt_tokens_details.cached_tokens,
              }),
            },
          }),
          ...(chunk.usage.completion_tokens_details && {
            completion_tokens_details: {
              ...(chunk.usage.completion_tokens_details.reasoning_tokens !== undefined && {
                reasoning_tokens: chunk.usage.completion_tokens_details.reasoning_tokens,
              }),
            },
          }),
        }
      : null,
  };
}

export async function* adaptOpenAIStream(
  stream: AsyncIterable<ChatCompletionChunk>,
): AsyncIterable<StreamChunk> {
  for await (const chunk of stream) {
    yield toStreamChunk(chunk);
  }
}

export function recordInvalidOpenAiChunk(
  recorder: RunnerCallRecorder,
  chunk: unknown,
  issues: Parameters<typeof runnerCallUnknownUpstreamPreview>[0]['issues'],
): void {
  recorder.unknownUpstream({
    rawPreview: runnerCallUnknownUpstreamPreview({
      label: 'Invalid OpenAI stream chunk',
      value: chunk,
      issues,
    }),
    backendMetadata: {
      backendKind: recorder.context.backendKind,
      source: 'openai-stream',
      parser: 'stream_chunk',
      upstreamType: 'chat.completion.chunk',
    },
  });
}
