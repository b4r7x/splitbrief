import { describe, expect, it } from 'vitest';
import { parseStreamLine } from './parse-stream-json.js';

function jsonLine(value: unknown): string {
  return JSON.stringify(value);
}

describe('parseStreamLine', () => {
  it.each([
    [
      'assistant text and session',
      jsonLine({
        type: 'assistant',
        session_id: 'sess-1',
        message: {
          content: [
            { type: 'text', text: 'Hello world' },
            { type: 'text', text: ' more text' },
          ],
        },
      }),
      { text: 'Hello world more text', channel: 'assistant', sessionId: 'sess-1' },
    ],
    [
      'result text, usage, and session',
      jsonLine({
        type: 'result',
        session_id: 'sess-2',
        result: 'Final answer here',
        usage: { input_tokens: 1000, output_tokens: 500 },
      }),
      {
        text: 'Final answer here',
        channel: 'result',
        sessionId: 'sess-2',
        isResult: true,
        usage: { inputTokens: 1000, outputTokens: 500 },
        usageSemantics: 'final',
      },
    ],
    [
      'result text without usage',
      jsonLine({
        type: 'result',
        session_id: 'sess-no-usage',
        result: 'Final answer only',
      }),
      {
        text: 'Final answer only',
        channel: 'result',
        sessionId: 'sess-no-usage',
        isResult: true,
      },
    ],
    [
      'session-only event',
      jsonLine({ type: 'system', session_id: 'sess-3' }),
      { sessionId: 'sess-3' },
    ],
    [
      'assistant tool_use',
      jsonLine({
        type: 'assistant',
        session_id: 'sess-tool',
        message: {
          content: [
            {
              type: 'tool_use',
              id: 'tool-1',
              name: 'read_file',
              input: { path: '/tmp/test.ts' },
            },
          ],
        },
      }),
      {
        sessionId: 'sess-tool',
        toolUse: [{ id: 'tool-1', name: 'read_file', input: { path: '/tmp/test.ts' } }],
      },
    ],
    [
      'assistant mixed text and tool_use',
      jsonLine({
        type: 'assistant',
        session_id: 'sess-mixed',
        message: {
          content: [
            { type: 'text', text: 'Let me read that file.' },
            {
              type: 'tool_use',
              name: 'write_file',
              input: { path: '/tmp/out.ts', content: 'code' },
            },
          ],
        },
      }),
      {
        text: 'Let me read that file.',
        channel: 'assistant',
        sessionId: 'sess-mixed',
        toolUse: [{ name: 'write_file', input: { path: '/tmp/out.ts', content: 'code' } }],
      },
    ],
    [
      'assistant skips non-text non-tool blocks',
      jsonLine({
        type: 'assistant',
        message: {
          content: [
            { type: 'tool_use', name: 'read_file' },
            { type: 'text', text: 'visible text' },
            { type: 'image', source: {} },
          ],
        },
      }),
      { text: 'visible text', channel: 'assistant', toolUse: [{ name: 'read_file', input: {} }] },
    ],
    [
      'malformed JSON',
      'not valid json {{{',
      {
        warning: [
          expect.objectContaining({
            code: 'malformed_stream_json',
            source: 'stream-json',
            parser: 'stream-json',
            upstreamType: 'malformed_json',
            channel: 'stdout',
            message: expect.stringContaining('Malformed stream-json record'),
            fingerprint: expect.stringMatching(/^rw:/),
          }),
        ],
      },
    ],
    ['empty line', '', {}],
    ['whitespace-only line', '   \t  ', {}],
    [
      'stream_event text delta',
      jsonLine({
        type: 'stream_event',
        event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'live' } },
      }),
      { text: 'live', channel: 'assistant' },
    ],
    [
      'stream_event tool start',
      jsonLine({
        type: 'stream_event',
        session_id: 'sess-live',
        event: {
          type: 'content_block_start',
          content_block: { type: 'tool_use', id: 'tool-live', name: 'Read', input: {} },
        },
      }),
      { sessionId: 'sess-live', toolUseStart: [{ id: 'tool-live', name: 'Read', input: {} }] },
    ],
    [
      'stream_event tool input delta',
      jsonLine({
        type: 'stream_event',
        event: {
          type: 'content_block_delta',
          index: 1,
          delta: { type: 'input_json_delta', partial_json: '{"file_path":"src/app.ts"}' },
        },
      }),
      {
        toolUseDelta: [{ id: 'content-block-1', inputDelta: '{"file_path":"src/app.ts"}' }],
      },
    ],
    [
      'Claude retry progress',
      jsonLine({ type: 'api_retry', session_id: 'sess-retry' }),
      { text: 'api_retry', channel: 'system', sessionId: 'sess-retry' },
    ],
  ] as const)('parses %s', (_name, line, expected) => {
    expect(parseStreamLine(line)).toEqual(expected);
  });

  it('preserves result text and isResult when usage is malformed', () => {
    const line = jsonLine({
      type: 'result',
      session_id: 'sess-bad-usage',
      result: 'Final answer survives',
      usage: { input_tokens: '10', output_tokens: 5 },
    });

    expect(parseStreamLine(line)).toEqual({
      text: 'Final answer survives',
      channel: 'result',
      sessionId: 'sess-bad-usage',
      isResult: true,
    });
  });
});
