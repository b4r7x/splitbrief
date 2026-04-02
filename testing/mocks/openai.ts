import { vi } from 'vitest';

interface MockChunk {
  content?: string;
  usage?: { prompt_tokens: number; completion_tokens: number };
}

export function createMockOpenAIClient(chunks: MockChunk[]) {
  return {
    chat: {
      completions: {
        create: vi.fn().mockResolvedValue({
          [Symbol.asyncIterator]() {
            let i = 0;
            return {
              async next() {
                if (i >= chunks.length) return { done: true as const, value: undefined };
                const chunk = chunks[i++]!;
                return {
                  done: false as const,
                  value: {
                    choices: [{ delta: { content: chunk.content ?? null } }],
                    usage: chunk.usage ?? null,
                  },
                };
              },
            };
          },
        }),
      },
    },
  } as any;
}

export function createMockOpenAIError(error: Error) {
  return {
    chat: {
      completions: {
        create: vi.fn().mockRejectedValue(error),
      },
    },
  } as any;
}
