import { describe, expect, it } from 'vitest';
import { getLineParser } from './output-parsers.js';
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
      { text: 'Hello world more text', sessionId: 'sess-1' },
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
        sessionId: 'sess-2',
        isResult: true,
        usage: { inputTokens: 1000, outputTokens: 500 },
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
          content: [{ type: 'tool_use', name: 'read_file', input: { path: '/tmp/test.ts' } }],
        },
      }),
      { sessionId: 'sess-tool', toolUse: [{ name: 'read_file', input: { path: '/tmp/test.ts' } }] },
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
        sessionId: 'sess-mixed',
        toolUse: [{ name: 'write_file', input: { path: '/tmp/out.ts', content: 'code' } }],
      },
    ],
    [
      'tool_use without input',
      jsonLine({
        type: 'assistant',
        message: { content: [{ type: 'tool_use', name: 'list_files' }] },
      }),
      { toolUse: [{ name: 'list_files', input: {} }] },
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
      { text: 'visible text', toolUse: [{ name: 'read_file', input: {} }] },
    ],
    ['malformed JSON', 'not valid json {{{', {}],
    ['empty line', '', {}],
    ['whitespace-only line', '   \t  ', {}],
  ] as const)('parses %s', (_name, line, expected) => {
    expect(parseStreamLine(line)).toEqual(expected);
  });
});

describe('getLineParser("stream-json")', () => {
  const parse = getLineParser('stream-json');

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
      { text: 'doing something', toolUse: [{ name: 'write_file', input: { path: 'out.ts' } }] },
    ],
    [
      'plain text event',
      jsonLine({ type: 'assistant', message: { content: [{ type: 'text', text: 'hello' }] } }),
      { text: 'hello' },
    ],
    [
      'result event',
      jsonLine({ type: 'result', result: 'done', usage: { input_tokens: 10, output_tokens: 5 } }),
      { text: 'done', usage: { inputTokens: 10, outputTokens: 5 }, isResult: true },
    ],
  ] as const)('wraps %s', (_name, line, expected) => {
    expect(parse(line)).toEqual(expected);
  });
});
