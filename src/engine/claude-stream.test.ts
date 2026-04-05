import { describe, it, expect } from 'vitest';
import { parseStreamLine } from './claude-stream.js';

describe('parseStreamLine', () => {
  it('extracts text from assistant event', () => {
    const line = JSON.stringify({
      type: 'assistant',
      session_id: 'sess-1',
      message: {
        content: [
          { type: 'text', text: 'Hello world' },
          { type: 'text', text: ' more text' },
        ],
      },
    });
    const result = parseStreamLine(line);
    expect(result.text).toBe('Hello world more text');
    expect(result.sessionId).toBe('sess-1');
    expect(result.isResult).toBe(false);
    expect(result.usage).toBe(null);
  });

  it('extracts text and usage from result event', () => {
    const line = JSON.stringify({
      type: 'result',
      session_id: 'sess-2',
      result: 'Final answer here',
      usage: { input_tokens: 1000, output_tokens: 500 },
    });
    const result = parseStreamLine(line);
    expect(result.text).toBe('Final answer here');
    expect(result.sessionId).toBe('sess-2');
    expect(result.isResult).toBe(true);
    expect(result.usage).toEqual({ inputTokens: 1000, outputTokens: 500 });
  });

  it('extracts session_id from any event type', () => {
    const line = JSON.stringify({
      type: 'system',
      session_id: 'sess-3',
    });
    const result = parseStreamLine(line);
    expect(result.text).toBe(null);
    expect(result.sessionId).toBe('sess-3');
    expect(result.isResult).toBe(false);
  });

  it('returns null fields for malformed JSON', () => {
    const result = parseStreamLine('not valid json {{{');
    expect(result.text).toBe(null);
    expect(result.sessionId).toBe(null);
    expect(result.isResult).toBe(false);
    expect(result.usage).toBe(null);
  });

  it('returns null fields for empty line', () => {
    const result = parseStreamLine('');
    expect(result.text).toBe(null);
    expect(result.sessionId).toBe(null);
    expect(result.isResult).toBe(false);
  });

  it('returns null fields for whitespace-only line', () => {
    const result = parseStreamLine('   \t  ');
    expect(result.text).toBe(null);
    expect(result.sessionId).toBe(null);
  });

  it('handles result event without usage', () => {
    const line = JSON.stringify({
      type: 'result',
      result: 'Answer',
    });
    const result = parseStreamLine(line);
    expect(result.text).toBe('Answer');
    expect(result.isResult).toBe(true);
    expect(result.usage).toBe(null);
    expect(result.sessionId).toBe(null);
  });

  it('handles assistant event with no text blocks', () => {
    const line = JSON.stringify({
      type: 'assistant',
      message: { content: [{ type: 'tool_use', name: 'something' }] },
    });
    const result = parseStreamLine(line);
    expect(result.text).toBe(null);
  });

  it('assistant event with multiple content blocks concatenates text', () => {
    const line = JSON.stringify({
      type: 'assistant',
      session_id: 'sess-multi',
      message: {
        content: [
          { type: 'text', text: 'First ' },
          { type: 'text', text: 'Second ' },
          { type: 'text', text: 'Third' },
        ],
      },
    });
    const result = parseStreamLine(line);
    expect(result.text).toBe('First Second Third');
    expect(result.sessionId).toBe('sess-multi');
  });

  it('assistant event with non-text content blocks skips them', () => {
    const line = JSON.stringify({
      type: 'assistant',
      message: {
        content: [
          { type: 'tool_use', name: 'read_file' },
          { type: 'text', text: 'visible text' },
          { type: 'image', source: {} },
        ],
      },
    });
    const result = parseStreamLine(line);
    expect(result.text).toBe('visible text');
  });

  it('event with session_id but no other useful data', () => {
    const line = JSON.stringify({
      type: 'ping',
      session_id: 'sess-ping',
    });
    const result = parseStreamLine(line);
    expect(result.text).toBe(null);
    expect(result.sessionId).toBe('sess-ping');
    expect(result.isResult).toBe(false);
    expect(result.usage).toBe(null);
  });

  it('parses tool_use content blocks into toolUse array', () => {
    const line = JSON.stringify({
      type: 'assistant',
      session_id: 'sess-tool',
      message: {
        content: [
          { type: 'tool_use', name: 'read_file', input: { path: '/tmp/test.ts' } },
        ],
      },
    });
    const result = parseStreamLine(line);
    expect(result.toolUse).toEqual([{ name: 'read_file', input: { path: '/tmp/test.ts' } }]);
    expect(result.text).toBe(null);
  });

  it('returns both text and toolUse for mixed content blocks', () => {
    const line = JSON.stringify({
      type: 'assistant',
      session_id: 'sess-mixed',
      message: {
        content: [
          { type: 'text', text: 'Let me read that file.' },
          { type: 'tool_use', name: 'write_file', input: { path: '/tmp/out.ts', content: 'code' } },
        ],
      },
    });
    const result = parseStreamLine(line);
    expect(result.text).toBe('Let me read that file.');
    expect(result.toolUse).toEqual([{ name: 'write_file', input: { path: '/tmp/out.ts', content: 'code' } }]);
  });

  it('defaults tool_use input to empty object when missing', () => {
    const line = JSON.stringify({
      type: 'assistant',
      message: {
        content: [
          { type: 'tool_use', name: 'list_files' },
        ],
      },
    });
    const result = parseStreamLine(line);
    expect(result.toolUse).toEqual([{ name: 'list_files', input: {} }]);
  });
});
