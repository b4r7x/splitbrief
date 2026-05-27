import { describe, it, expect } from "vitest";
import { streamCompletion } from "./openai-stream.js";

type MockClient = Parameters<typeof streamCompletion>[0];

function makeMockClient(
  chunks: Array<{
    content?: string;
    usage?: { prompt_tokens: number; completion_tokens: number };
  }>,
) : MockClient {
  return {
    chat: {
      completions: {
        create: async () => {
          return {
            [Symbol.asyncIterator]() {
              let i = 0;
              return {
                async next() {
                  if (i >= chunks.length)
                    return { done: true, value: undefined };
                  const chunk = chunks[i++];
                  if (!chunk) return { done: true, value: undefined };
                  return {
                    done: false,
                    value: {
                      choices: [{ delta: { content: chunk.content ?? null } }],
                      usage: chunk.usage ?? null,
                    },
                  };
                },
              };
            },
          };
        },
      },
    },
  };
}

describe("streamCompletion", () => {
  it("returns concatenated text from stream chunks", async () => {
    const client = makeMockClient([
      { content: "Hello" },
      { content: " world" },
    ]);

    const result = await streamCompletion(
      client,
      "test-model",
      [{ role: "user", content: "hi" }],
      { temperature: 0.2, onProgress: () => {} },
    );

    expect(result.text).toBe("Hello world");
  });

  it("emits a progress update for each streamed chunk", async () => {
    const client = makeMockClient([
      { content: "a" },
      { content: "b" },
      { content: "c" },
    ]);
    const progressCalls: string[] = [];

    await streamCompletion(
      client,
      "test-model",
      [{ role: "user", content: "hi" }],
      { temperature: 0.2, onProgress: (text) => progressCalls.push(text) },
    );

    expect(progressCalls).toEqual(["a", "b", "c"]);
  });

  it("captures usage from final chunk", async () => {
    const client = makeMockClient([
      { content: "response" },
      { usage: { prompt_tokens: 100, completion_tokens: 50 } },
    ]);

    const result = await streamCompletion(
      client,
      "test-model",
      [{ role: "user", content: "hi" }],
      { temperature: 0.2, onProgress: () => {} },
    );

    expect(result.usage).toEqual({ inputTokens: 100, outputTokens: 50 });
  });

  it("rejects instead of returning partial text when aborted mid-stream", async () => {
    const controller = new AbortController();
    const client = makeMockClient([
      { content: "partial" },
      { content: " must-not-complete" },
    ]);

    await expect(
      streamCompletion(
        client,
        "test-model",
        [{ role: "user", content: "hi" }],
        {
          temperature: 0.2,
          signal: controller.signal,
          onProgress: () => controller.abort(new Error("cancelled")),
        },
      ),
    ).rejects.toThrow("cancelled");
  });

  it("maps ECONNREFUSED to a user-friendly error", async () => {
    const client: MockClient = {
      chat: {
        completions: {
          create: async () => {
            throw Object.assign(new Error("Connection refused"), {
              code: "ECONNREFUSED",
            });
          },
        },
      },
    };

    await expect(
      streamCompletion(
        client,
        "test-model",
        [{ role: "user", content: "hi" }],
        { temperature: 0.2, onProgress: () => {} },
      ),
    ).rejects.toThrow(/Cannot connect to/);
  });

  it("maps HTTP error status to a user-friendly error", async () => {
    const client: MockClient = {
      chat: {
        completions: {
          create: async () => {
            throw Object.assign(new Error("Not Found"), { status: 404 });
          },
        },
      },
    };

    await expect(
      streamCompletion(
        client,
        "test-model",
        [{ role: "user", content: "hi" }],
        { temperature: 0.2, onProgress: () => {} },
      ),
    ).rejects.toThrow(/API error 404/);
  });

});
