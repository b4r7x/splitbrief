import type OpenAI from 'openai';
import { adaptOpenAIStream } from './chunk.js';
import { toOpenAIRequest, type StreamClient } from './request.js';

export function toStreamClient(client: OpenAI): StreamClient {
  return {
    chat: {
      completions: {
        create: async (body, requestOptions) => {
          const stream = await client.chat.completions.create(
            toOpenAIRequest(body),
            requestOptions ?? undefined,
          );
          return adaptOpenAIStream(stream);
        },
      },
    },
  };
}
