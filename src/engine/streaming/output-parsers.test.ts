import { describe, expect, it } from 'vitest';
import { getLineParser } from './output-parsers.js';
import { parseJsonlLine } from './parse-jsonl.js';
import { parseOpencodeLine } from './parse-opencode.js';
import { parseTextLine } from './parse-text.js';

describe('getLineParser dispatch', () => {
  it('routes text lines through parseTextLine', () => {
    const line = 'Tokens: 10 sent, 5 received';
    expect(getLineParser('text')(line)).toEqual(parseTextLine(line));
  });

  it('routes jsonl lines through parseJsonlLine', () => {
    const line = JSON.stringify({
      type: 'turn.completed',
      usage: { input_tokens: 1, output_tokens: 2 },
    });
    expect(getLineParser('jsonl')(line)).toEqual(parseJsonlLine(line));
  });

  it('routes opencode lines through parseOpencodeLine', () => {
    const line = JSON.stringify({
      type: 'step_start',
      sessionID: 'sess',
      part: { type: 'step-start' },
    });
    expect(getLineParser('opencode')(line)).toEqual(parseOpencodeLine(line));
  });

  it('routes stream-json through wrapStreamParser', () => {
    const line = JSON.stringify({
      type: 'assistant',
      message: { content: [{ type: 'text', text: 'hi' }] },
    });
    const parsed = getLineParser('stream-json')(line);
    expect(parsed).toEqual({ text: 'hi', channel: 'assistant' });
  });
});

describe('wrapStreamParser field projections', () => {
  const parse = getLineParser('stream-json');
  const jsonLine = (value: unknown) => JSON.stringify(value);

  it('forwards text', () => {
    expect(
      parse(
        jsonLine({ type: 'assistant', message: { content: [{ type: 'text', text: 'hello' }] } }),
      ),
    ).toEqual(expect.objectContaining({ text: 'hello' }));
  });

  it('forwards channel', () => {
    expect(
      parse(jsonLine({ type: 'assistant', message: { content: [{ type: 'text', text: 'x' }] } })),
    ).toEqual(expect.objectContaining({ channel: 'assistant' }));
  });

  it('forwards usage and usageSemantics on result events', () => {
    expect(
      parse(
        jsonLine({ type: 'result', result: 'done', usage: { input_tokens: 10, output_tokens: 5 } }),
      ),
    ).toEqual(
      expect.objectContaining({
        usage: { inputTokens: 10, outputTokens: 5 },
        usageSemantics: 'final',
      }),
    );
  });

  it('forwards isResult', () => {
    expect(parse(jsonLine({ type: 'result', result: 'done' }))).toEqual(
      expect.objectContaining({ isResult: true }),
    );
  });

  it('forwards isError when present on result records', () => {
    expect(parse(jsonLine({ type: 'result', is_error: true, result: 'failed' }))).toEqual(
      expect.objectContaining({ isError: true }),
    );
  });

  it('forwards sessionId', () => {
    expect(parse(jsonLine({ type: 'system', session_id: 'sess-3' }))).toEqual(
      expect.objectContaining({ sessionId: 'sess-3' }),
    );
  });

  it('forwards toolUse', () => {
    expect(
      parse(
        jsonLine({
          type: 'assistant',
          message: { content: [{ type: 'tool_use', name: 'read_file', input: {} }] },
        }),
      ),
    ).toEqual(expect.objectContaining({ toolUse: [{ name: 'read_file', input: {} }] }));
  });

  it('forwards toolUseStart', () => {
    expect(
      parse(
        jsonLine({
          type: 'stream_event',
          event: {
            type: 'content_block_start',
            content_block: { type: 'tool_use', id: 't1', name: 'Read', input: {} },
          },
        }),
      ),
    ).toEqual(expect.objectContaining({ toolUseStart: [{ id: 't1', name: 'Read', input: {} }] }));
  });

  it('forwards toolUseDelta', () => {
    expect(
      parse(
        jsonLine({
          type: 'stream_event',
          event: {
            type: 'content_block_delta',
            index: 1,
            delta: { type: 'input_json_delta', partial_json: '{}' },
          },
        }),
      ),
    ).toEqual(
      expect.objectContaining({ toolUseDelta: [{ id: 'content-block-1', inputDelta: '{}' }] }),
    );
  });

  it('forwards warning on malformed JSON', () => {
    expect(parse('not valid json {{{')).toEqual({
      warning: [
        expect.objectContaining({
          code: 'malformed_stream_json',
          source: 'stream-json',
          parser: 'stream-json',
          upstreamType: 'malformed_json',
          channel: 'stdout',
        }),
      ],
    });
  });

  it('omits undefined optional fields from the wrapped parse result', () => {
    expect(parse(jsonLine({ type: 'system', session_id: 'only-session' }))).toEqual({
      sessionId: 'only-session',
    });
  });
});

describe('getLineParser stream-json wrap integration', () => {
  const parse = getLineParser('stream-json');
  const jsonLine = (value: unknown) => JSON.stringify(value);

  it.each([
    [
      'tool-only assistant event',
      jsonLine({
        type: 'assistant',
        session_id: 'sess-wrap',
        message: {
          content: [{ type: 'tool_use', name: 'read_file', input: { path: 'src/foo.ts' } }],
        },
      }),
      { sessionId: 'sess-wrap', toolUse: [{ name: 'read_file', input: { path: 'src/foo.ts' } }] },
    ],
    [
      'mixed text and tool event',
      jsonLine({
        type: 'assistant',
        message: {
          content: [
            { type: 'text', text: 'doing something' },
            { type: 'tool_use', name: 'write_file', input: { path: 'out.ts' } },
          ],
        },
      }),
      {
        text: 'doing something',
        channel: 'assistant',
        toolUse: [{ name: 'write_file', input: { path: 'out.ts' } }],
      },
    ],
    [
      'plain text event',
      jsonLine({ type: 'assistant', message: { content: [{ type: 'text', text: 'hello' }] } }),
      { text: 'hello', channel: 'assistant' },
    ],
    [
      'result event',
      jsonLine({ type: 'result', result: 'done', usage: { input_tokens: 10, output_tokens: 5 } }),
      {
        text: 'done',
        channel: 'result',
        usage: { inputTokens: 10, outputTokens: 5 },
        usageSemantics: 'final',
        isResult: true,
      },
    ],
  ] as const)('wraps %s', (_name, line, expected) => {
    expect(parse(line)).toEqual(expected);
  });

  it('wraps malformed stream-json lines as warnings', () => {
    expect(parse('not valid json {{{')).toEqual({
      warning: [
        expect.objectContaining({
          code: 'malformed_stream_json',
          source: 'stream-json',
          parser: 'stream-json',
          upstreamType: 'malformed_json',
          channel: 'stdout',
        }),
      ],
    });
  });
});
