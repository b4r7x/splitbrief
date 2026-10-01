import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { makeRunnerCallResult } from '#testing/helpers/factories/runner-call.js';
import { streamError } from '../streaming/stream-errors.js';
import { fallbackInstruction, requestTyped } from '../runners/typed-output.js';
import { isResponseFormatRejection, withResponseFormatFallback } from './api.js';
import { createPlannerCallContext } from './call-context.js';

type Send = Parameters<typeof withResponseFormatFallback>[0]['send'];

const schema = { json: { type: 'object' }, name: 'probe' };

const callContext = createPlannerCallContext(
  { backendKind: 'api', runnerName: 'ollama' },
  'planner',
);

const completed = makeRunnerCallResult({
  status: 'completed',
  text: '{"answer":"a","count":1}',
});

const rejectedResponseFormat = streamError.httpStatus(
  'ollama',
  400,
  "Unsupported parameter: 'response_format'",
);

describe('isResponseFormatRejection', () => {
  it('does not treat a plain error as a response_format rejection', () => {
    expect(isResponseFormatRejection(new Error('x'))).toBe(false);
  });
});

describe('withResponseFormatFallback', () => {
  it('sends the schema as response_format and keeps a successful first result', async () => {
    const send = vi.fn<Send>().mockResolvedValue(completed);

    const result = await withResponseFormatFallback({ prompt: 'q', schema, callContext, send });

    expect(result).toBe(completed);
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0]?.[1]).toEqual({
      type: 'json_schema',
      json_schema: { name: 'probe', schema: { type: 'object' } },
    });
  });

  it('retries once without response_format and appends the fallback instruction', async () => {
    const send = vi
      .fn<Send>()
      .mockRejectedValueOnce(rejectedResponseFormat)
      .mockResolvedValueOnce(completed);

    const result = await withResponseFormatFallback({ prompt: 'q', schema, callContext, send });

    expect(result).toBe(completed);
    expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.calls[1]?.[1]).toBeUndefined();
    expect(send.mock.calls[1]?.[0]).toBe('q' + fallbackInstruction({ type: 'object' }));
  });

  it('gives the retry its own call id with the same seat identity', async () => {
    const send = vi
      .fn<Send>()
      .mockRejectedValueOnce(rejectedResponseFormat)
      .mockResolvedValueOnce(completed);

    await withResponseFormatFallback({ prompt: 'q', schema, callContext, send });

    const first = send.mock.calls[0]?.[2];
    const retry = send.mock.calls[1]?.[2];
    expect(first).toBe(callContext);
    expect(retry?.callId).not.toBe(callContext.callId);
    expect(retry).toMatchObject({ role: 'planner', backendKind: 'api', runnerName: 'ollama' });
  });

  it('propagates a 400 that is not about response_format after one send', async () => {
    const failure = streamError.httpStatus('ollama', 400, 'max_tokens too large');
    const send = vi.fn<Send>().mockRejectedValue(failure);

    await expect(
      withResponseFormatFallback({ prompt: 'q', schema, callContext, send }),
    ).rejects.toBe(failure);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('propagates a response_format failure at any other status after one send', async () => {
    const failure = streamError.httpStatus('ollama', 500, 'response_format broke');
    const send = vi.fn<Send>().mockRejectedValue(failure);

    await expect(
      withResponseFormatFallback({ prompt: 'q', schema, callContext, send }),
    ).rejects.toBe(failure);
    expect(send).toHaveBeenCalledTimes(1);
  });
});

describe('a typed call through the API planner fallback', () => {
  it('serves requestTyped from the retry inside the one seat call', async () => {
    const send = vi
      .fn<Send>()
      .mockRejectedValueOnce(rejectedResponseFormat)
      .mockResolvedValueOnce(completed);

    const result = await requestTyped({
      prompt: 'q',
      schema: z.object({ answer: z.string(), count: z.number() }),
      jsonSchema: { type: 'object' },
      schemaName: 'probe',
      call: {
        seat: 'planner',
        typedOutput: 'native',
        canResume: false,
        invoke: ({ prompt, schema: callSchema }) =>
          withResponseFormatFallback({
            prompt,
            schema: callSchema ?? { json: {}, name: 'none' },
            callContext,
            send,
          }),
      },
    });

    expect(result).toMatchObject({ value: { answer: 'a', count: 1 } });
    expect(send).toHaveBeenCalledTimes(2);
  });
});
