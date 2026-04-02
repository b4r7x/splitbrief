import { describe, it, expect, beforeAll } from 'vitest';
import { guardOllama, type TestGuard } from './guard.js';

const MODEL = 'qwen2.5-coder:7b';
const OLLAMA_BASE = 'http://localhost:11434';

let g: TestGuard;
let modelAvailable = false;

beforeAll(async () => {
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

describe('Ollama integration', () => {
  it('API connectivity — /api/tags returns models array', { timeout: 60_000 }, async (t) => {
    if (g.skip) { t.skip(); return; }

    const res = await fetch(`${OLLAMA_BASE}/api/tags`);
    expect(res.ok).toBe(true);

    const data = (await res.json()) as { models: unknown };
    expect(Array.isArray(data.models)).toBeTruthy();
  });

  it('code generation — non-streaming chat completion', { timeout: 60_000 }, async (t) => {
    if (g.skip) { t.skip(); return; }
    if (!modelAvailable) { t.skip(); return; }

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

    expect(res.ok).toBe(true);

    const data = (await res.json()) as {
      choices: Array<{ message: { content: string } }>;
      usage: { prompt_tokens: number; completion_tokens: number };
    };

    expect(data.choices.length).toBeGreaterThan(0);
    const content = data.choices[0].message.content;
    expect(typeof content === 'string' && content.length > 0).toBeTruthy();

    expect(data.usage).toBeTruthy();
    expect(data.usage.prompt_tokens).toBeGreaterThan(0);
    expect(data.usage.completion_tokens).toBeGreaterThan(0);
  });

  it('streaming with usage — final chunk contains token counts', { timeout: 60_000 }, async (t) => {
    if (g.skip) { t.skip(); return; }
    if (!modelAvailable) { t.skip(); return; }

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

    expect(res.ok).toBe(true);
    expect(res.body).toBeTruthy();

    const decoder = new TextDecoder();
    const chunks: Array<{
      choices: Array<{ delta: { content?: string } }>;
      usage?: { prompt_tokens: number; completion_tokens: number };
    }> = [];

    for await (const raw of res.body!) {
      const text = decoder.decode(raw as Uint8Array, { stream: true });
      const lines = text.split('\n').filter((l) => l.startsWith('data: '));

      for (const line of lines) {
        const payload = line.slice('data: '.length).trim();
        if (payload === '[DONE]') continue;
        chunks.push(JSON.parse(payload));
      }
    }

    expect(chunks.length).toBeGreaterThan(0);

    const withUsage = chunks.filter((c) => c.usage);
    expect(withUsage.length).toBeGreaterThan(0);

    const usage = withUsage[withUsage.length - 1].usage!;
    expect(usage.prompt_tokens).toBeGreaterThan(0);
    expect(usage.completion_tokens).toBeGreaterThan(0);
  });
});
