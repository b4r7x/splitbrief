import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { streamAnthropicCompletion } from './stream.js';
import { buildAnthropicStreamRequest } from './request.js';

const MINIMAL_SSE = 'event: message_stop\ndata: {"type":"message_stop"}\n\n';

describe('buildAnthropicStreamRequest', () => {
  it('omits temperature and sets high-effort thinking with max_tokens above budget', () => {
    const { body } = buildAnthropicStreamRequest({
      apiKey: 'sk-ant-test',
      apiBase: 'https://api.anthropic.com/v1',
      model: 'claude-sonnet-4-6',
      messages: [{ role: 'user', content: 'hi' }],
      system: undefined,
      temperature: 0.7,
      effort: 'high',
    });

    expect(body.thinking).toEqual({ type: 'enabled', budget_tokens: 24_000 });
    expect(body).not.toHaveProperty('temperature');
    const thinking = body.thinking as { budget_tokens: number };
    expect(typeof body.max_tokens).toBe('number');
    expect(body.max_tokens as number).toBeGreaterThan(thinking.budget_tokens);
  });
});

describe('streamAnthropicCompletion request wiring', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('posts the built request body to the messages endpoint', async () => {
    vi.mocked(globalThis.fetch).mockResolvedValue(
      new Response(MINIMAL_SSE, { status: 200, headers: { 'Content-Type': 'text/event-stream' } }),
    );

    await streamAnthropicCompletion({
      apiKey: 'sk-ant-test',
      apiBase: 'https://api.anthropic.com/v1',
      model: 'claude-sonnet-4-6',
      messages: [{ role: 'user', content: 'hi' }],
      temperature: 0.3,
      onProgress: () => {},
    });

    expect(vi.mocked(globalThis.fetch)).toHaveBeenCalledWith(
      'https://api.anthropic.com/v1/messages',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({ 'x-api-key': 'sk-ant-test' }),
      }),
    );
  });
});
