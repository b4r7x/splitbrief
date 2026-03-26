import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { guardOllama, type TestGuard } from './guard.js';

const MODEL = 'qwen2.5-coder:7b';
const OLLAMA_BASE = 'http://localhost:11434';

let g: TestGuard;
let modelAvailable = false;

before(async () => {
  g = await guardOllama();
  if (!g.skip) {
    try {
      const res = await fetch(`${OLLAMA_BASE}/api/tags`);
      const data = (await res.json()) as { models: Array<{ name: string }> };
      modelAvailable = data.models.some((m) => m.name.startsWith(MODEL));
    } catch {
      modelAvailable = false;
    }
  }
});

describe('Ollama integration', { skip: undefined as string | false | undefined }, function () {
  before(function () {
    // Apply the skip at describe level after guard resolves.
    // node:test evaluates { skip } at registration time, so we
    // assert inside tests instead and rely on the top-level guard.
  });

  it('API connectivity — /api/tags returns models array', { timeout: 60_000 }, async (t) => {
    if (g.skip) return t.skip(g.skip);

    const res = await fetch(`${OLLAMA_BASE}/api/tags`);
    assert.equal(res.ok, true, `Expected 200, got ${res.status}`);

    const data = (await res.json()) as { models: unknown };
    assert.ok(Array.isArray(data.models), 'Expected models to be an array');
  });

  it('code generation — non-streaming chat completion', { timeout: 60_000 }, async (t) => {
    if (g.skip) return t.skip(g.skip);
    if (!modelAvailable) return t.skip(`Model ${MODEL} not available`);

    const res = await fetch(`${OLLAMA_BASE}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: MODEL,
        messages: [
          {
            role: 'user',
            content: 'Write a TypeScript function that adds two numbers. Output only the code.',
          },
        ],
        stream: false,
      }),
    });

    assert.equal(res.ok, true, `Expected 200, got ${res.status}`);

    const data = (await res.json()) as {
      choices: Array<{ message: { content: string } }>;
      usage: { prompt_tokens: number; completion_tokens: number };
    };

    assert.ok(data.choices.length > 0, 'Expected at least one choice');
    const content = data.choices[0].message.content;
    assert.ok(typeof content === 'string' && content.length > 0, 'Expected non-empty content');

    assert.ok(data.usage, 'Expected usage object');
    assert.ok(data.usage.prompt_tokens > 0, `Expected prompt_tokens > 0, got ${data.usage.prompt_tokens}`);
    assert.ok(
      data.usage.completion_tokens > 0,
      `Expected completion_tokens > 0, got ${data.usage.completion_tokens}`,
    );
  });

  it('streaming with usage — final chunk contains token counts', { timeout: 60_000 }, async (t) => {
    if (g.skip) return t.skip(g.skip);
    if (!modelAvailable) return t.skip(`Model ${MODEL} not available`);

    const res = await fetch(`${OLLAMA_BASE}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: MODEL,
        messages: [
          {
            role: 'user',
            content: 'Write a TypeScript function that adds two numbers. Output only the code.',
          },
        ],
        stream: true,
        stream_options: { include_usage: true },
      }),
    });

    assert.equal(res.ok, true, `Expected 200, got ${res.status}`);
    assert.ok(res.body, 'Expected readable stream body');

    const decoder = new TextDecoder();
    const chunks: Array<{
      choices: Array<{ delta: { content?: string } }>;
      usage?: { prompt_tokens: number; completion_tokens: number };
    }> = [];

    for await (const raw of res.body) {
      const text = decoder.decode(raw as Uint8Array, { stream: true });
      const lines = text.split('\n').filter((l) => l.startsWith('data: '));

      for (const line of lines) {
        const payload = line.slice('data: '.length).trim();
        if (payload === '[DONE]') continue;
        chunks.push(JSON.parse(payload));
      }
    }

    assert.ok(chunks.length > 0, 'Expected at least one SSE chunk');

    const withUsage = chunks.filter((c) => c.usage);
    assert.ok(withUsage.length > 0, 'Expected at least one chunk with usage data');

    const usage = withUsage[withUsage.length - 1].usage!;
    assert.ok(usage.prompt_tokens > 0, `Expected prompt_tokens > 0, got ${usage.prompt_tokens}`);
    assert.ok(usage.completion_tokens > 0, `Expected completion_tokens > 0, got ${usage.completion_tokens}`);
  });
});
