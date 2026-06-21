import { describe, it, expect } from 'vitest';
import {
  isModuleNotFoundError,
  loadSdk,
  isAgentSdkAvailable,
  createAgentSdkBackend,
  processStream,
  PLANNER_ALLOWED_TOOLS,
  PLANNER_PERMISSION_MODE,
} from './agent-sdk-backend.js';
import {
  RUNNER_CALL_OUTPUT_MAX_BYTES,
  RUNNER_CALL_OUTPUT_MAX_EVENTS,
} from '../calls/output-limit.js';
import { RunnerCallEventSchema } from '../calls/schema.js';
import type { RunnerCallEvent } from '../calls/types.js';

async function* asyncIter<T>(items: T[]): AsyncIterable<T> {
  for (const item of items) yield item;
}

describe('isModuleNotFoundError', () => {
  it('returns true for ERR_MODULE_NOT_FOUND', () => {
    const err = Object.assign(new Error('Cannot find module'), { code: 'ERR_MODULE_NOT_FOUND' });
    expect(isModuleNotFoundError(err)).toBe(true);
  });

  it('returns true for MODULE_NOT_FOUND', () => {
    const err = Object.assign(new Error('Cannot find module'), { code: 'MODULE_NOT_FOUND' });
    expect(isModuleNotFoundError(err)).toBe(true);
  });

  it('returns true for "Cannot find package" message without code', () => {
    expect(isModuleNotFoundError(new Error('Cannot find package "@foo/bar"'))).toBe(true);
  });

  it('returns true for "Could not resolve" message without code', () => {
    expect(isModuleNotFoundError(new Error('Could not resolve "@foo/bar"'))).toBe(true);
  });

  it('returns false for other error codes', () => {
    const err = Object.assign(new Error('syntax error'), { code: 'ERR_INVALID_ARG_TYPE' });
    expect(isModuleNotFoundError(err)).toBe(false);
  });

  it('returns false for errors without code or matching message', () => {
    expect(isModuleNotFoundError(new TypeError('Cannot read properties'))).toBe(false);
  });

  it('returns false for non-error values', () => {
    expect(isModuleNotFoundError(null)).toBe(false);
    expect(isModuleNotFoundError(undefined)).toBe(false);
    expect(isModuleNotFoundError('string')).toBe(false);
  });
});

describe('loadSdk', () => {
  it('throws install message when SDK is not installed', async () => {
    await expect(loadSdk()).rejects.toThrow(
      'Agent SDK not installed. Run: npm install @anthropic-ai/claude-agent-sdk',
    );
  });
});

describe('planner read-only defaults', () => {
  it('excludes write tools and uses plan permission mode', () => {
    expect(PLANNER_ALLOWED_TOOLS).toEqual(['Read', 'Glob', 'Grep']);
    expect(PLANNER_PERMISSION_MODE).toBe('plan');
  });
});

describe('createAgentSdkBackend', () => {
  it('honors an already-aborted signal before loading the optional SDK peer', async () => {
    const controller = new AbortController();
    controller.abort(new Error('cancelled'));

    const backend = createAgentSdkBackend({ allowedTools: ['Read'] });
    await expect(
      backend.invoke({
        prompt: 'hello',
        projectDir: '/tmp/proj',
        model: 'claude-sonnet-4-5',
        onOutput: () => {},
        signal: controller.signal,
      }),
    ).rejects.toThrow('cancelled');
  });
});

describe('processStream', () => {
  it('calls onOutput for result-only text', async () => {
    const chunks: string[] = [];
    const result = await processStream({
      stream: asyncIter([
        {
          type: 'result',
          subtype: 'success',
          result: 'final answer',
          usage: { input_tokens: 1, output_tokens: 2 },
        },
      ]),
      onOutput: (text) => chunks.push(text),
    });

    expect(chunks).toEqual(['final answer']);
    expect(result.text).toBe('final answer');
  });

  it('streams only the missing result suffix after assistant text', async () => {
    const chunks: string[] = [];
    const result = await processStream({
      stream: asyncIter([
        {
          type: 'assistant',
          message: { content: [{ type: 'text', text: 'Hello' }] },
        },
        {
          type: 'result',
          subtype: 'success',
          result: 'Hello world',
        },
      ]),
      onOutput: (text) => chunks.push(text),
    });

    expect(chunks).toEqual(['Hello', ' world']);
    expect(result.text).toBe('Hello world');
  });

  it('records divergent result text as a typed replacement without replaying it to output', async () => {
    const chunks: string[] = [];
    const events: RunnerCallEvent[] = [];
    const result = await processStream({
      stream: asyncIter([
        {
          type: 'assistant',
          message: { content: [{ type: 'text', text: 'draft text' }] },
        },
        {
          type: 'result',
          subtype: 'success',
          result: 'final text',
        },
      ]),
      onOutput: (text) => chunks.push(text),
      onCallEvent: (event) => events.push(event),
    });

    expect(chunks).toEqual(['draft text']);
    expect(result.text).toBe('final text');
    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'call_text_delta',
        channel: 'result',
        text: 'final text',
        semantics: 'final',
      }),
    );
  });

  it('records malformed SDK messages and blocks as unknown upstream diagnostics', async () => {
    const events: RunnerCallEvent[] = [];
    const result = await processStream({
      stream: asyncIter([
        { type: 'unknown_sdk_event', payload: { value: 1 } },
        {
          type: 'assistant',
          message: {
            content: [
              { type: 'text', text: 123 },
              { type: 'text', text: 'ok' },
              { type: 'tool_use', id: 'tool-1', name: 42, input: {} },
            ],
          },
        },
        {
          type: 'result',
          subtype: 'success',
          result: 'ok',
        },
      ]),
      onOutput: () => {},
      onCallEvent: (event) => events.push(event),
    });

    expect(result.text).toBe('ok');
    expect(events.every((event) => RunnerCallEventSchema.safeParse(event).success)).toBe(true);
    expect(events.filter((event) => event.type === 'call_unknown_upstream')).toHaveLength(3);
    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'call_unknown_upstream',
        rawPreview: expect.stringContaining('Invalid Agent SDK stream message'),
        backendMetadata: expect.objectContaining({
          source: 'agent-sdk',
          parser: 'sdk_message',
        }),
      }),
    );
    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'call_text_delta',
        text: 'ok',
      }),
    );
  });

  it('caps many SDK text chunks before accumulating output', async () => {
    const events: RunnerCallEvent[] = [];
    const chunks: string[] = [];
    const stream = asyncIter([
      ...Array.from({ length: RUNNER_CALL_OUTPUT_MAX_EVENTS + 1 }, () => ({
        type: 'assistant',
        message: { content: [{ type: 'text', text: 'x' }] },
      })),
      { type: 'result', subtype: 'success', result: 'x'.repeat(RUNNER_CALL_OUTPUT_MAX_EVENTS + 1) },
    ]);

    await expect(
      processStream({
        stream,
        onOutput: (text) => chunks.push(text),
        onCallEvent: (event) => events.push(event),
      }),
    ).rejects.toMatchObject({
      kind: 'runner-call-failed',
      data: {
        status: 'truncated',
        output: 'x'.repeat(RUNNER_CALL_OUTPUT_MAX_EVENTS),
        error: { code: 'agent_sdk_output_text_limit' },
      },
    });

    expect(chunks).toHaveLength(RUNNER_CALL_OUTPUT_MAX_EVENTS);
    expect(events.filter((event) => event.type === 'call_text_delta')).toHaveLength(
      RUNNER_CALL_OUTPUT_MAX_EVENTS,
    );
  });

  it('caps one huge SDK result before recorder and output callbacks', async () => {
    const chunks: string[] = [];
    const events: RunnerCallEvent[] = [];

    await expect(
      processStream({
        stream: asyncIter([
          {
            type: 'result',
            subtype: 'success',
            result: 'x'.repeat(RUNNER_CALL_OUTPUT_MAX_BYTES + 1),
          },
        ]),
        onOutput: (text) => chunks.push(text),
        onCallEvent: (event) => events.push(event),
      }),
    ).rejects.toMatchObject({
      kind: 'runner-call-failed',
      data: {
        status: 'truncated',
        error: { code: 'agent_sdk_output_text_limit' },
      },
    });

    expect(Buffer.byteLength(chunks.join(''), 'utf8')).toBe(RUNNER_CALL_OUTPUT_MAX_BYTES);
    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'call_error',
        status: 'truncated',
        error: { code: 'agent_sdk_output_text_limit', message: expect.any(String) },
      }),
    );
  });
});

describe('isAgentSdkAvailable', () => {
  it('returns false when SDK is not installed regardless of API key', async () => {
    const originalKey = process.env.ANTHROPIC_API_KEY;
    try {
      process.env.ANTHROPIC_API_KEY = 'test-key';
      expect(await isAgentSdkAvailable()).toBe(false);

      delete process.env.ANTHROPIC_API_KEY;
      expect(await isAgentSdkAvailable()).toBe(false);
      expect(await isAgentSdkAvailable('sk-ant-configured-key')).toBe(false);
    } finally {
      if (originalKey === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = originalKey;
    }
  });
});
