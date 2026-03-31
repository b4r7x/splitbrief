import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseStreamLine } from '../src/engine/claude-stream.js';

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
    assert.equal(result.text, 'Hello world more text');
    assert.equal(result.sessionId, 'sess-1');
    assert.equal(result.isResult, false);
    assert.equal(result.usage, null);
    assert.equal(result.costUsd, null);
  });

  it('extracts text, usage, and costUsd from result event', () => {
    const line = JSON.stringify({
      type: 'result',
      session_id: 'sess-2',
      result: 'Final answer here',
      usage: { input_tokens: 1000, output_tokens: 500 },
      total_cost_usd: 0.42,
    });
    const result = parseStreamLine(line);
    assert.equal(result.text, 'Final answer here');
    assert.equal(result.sessionId, 'sess-2');
    assert.equal(result.isResult, true);
    assert.deepEqual(result.usage, { inputTokens: 1000, outputTokens: 500 });
    assert.equal(result.costUsd, 0.42);
  });

  it('extracts session_id from any event type', () => {
    const line = JSON.stringify({
      type: 'system',
      session_id: 'sess-3',
    });
    const result = parseStreamLine(line);
    assert.equal(result.text, null);
    assert.equal(result.sessionId, 'sess-3');
    assert.equal(result.isResult, false);
  });

  it('returns null fields for malformed JSON', () => {
    const result = parseStreamLine('not valid json {{{');
    assert.equal(result.text, null);
    assert.equal(result.sessionId, null);
    assert.equal(result.isResult, false);
    assert.equal(result.usage, null);
    assert.equal(result.costUsd, null);
  });

  it('returns null fields for empty line', () => {
    const result = parseStreamLine('');
    assert.equal(result.text, null);
    assert.equal(result.sessionId, null);
    assert.equal(result.isResult, false);
  });

  it('returns null fields for whitespace-only line', () => {
    const result = parseStreamLine('   \t  ');
    assert.equal(result.text, null);
    assert.equal(result.sessionId, null);
  });

  it('handles result event without usage', () => {
    const line = JSON.stringify({
      type: 'result',
      result: 'Answer',
    });
    const result = parseStreamLine(line);
    assert.equal(result.text, 'Answer');
    assert.equal(result.isResult, true);
    assert.equal(result.usage, null);
    assert.equal(result.costUsd, null);
    assert.equal(result.sessionId, null);
  });

  it('handles assistant event with no text blocks', () => {
    const line = JSON.stringify({
      type: 'assistant',
      message: { content: [{ type: 'tool_use', name: 'something' }] },
    });
    const result = parseStreamLine(line);
    assert.equal(result.text, null);
  });

  it('result event without total_cost_usd returns costUsd null', () => {
    const line = JSON.stringify({
      type: 'result',
      session_id: 'sess-no-cost',
      result: 'Some result',
      usage: { input_tokens: 100, output_tokens: 50 },
    });
    const result = parseStreamLine(line);
    assert.equal(result.isResult, true);
    assert.equal(result.costUsd, null);
    assert.deepEqual(result.usage, { inputTokens: 100, outputTokens: 50 });
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
    assert.equal(result.text, 'First Second Third');
    assert.equal(result.sessionId, 'sess-multi');
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
    assert.equal(result.text, 'visible text');
  });

  it('event with session_id but no other useful data', () => {
    const line = JSON.stringify({
      type: 'ping',
      session_id: 'sess-ping',
    });
    const result = parseStreamLine(line);
    assert.equal(result.text, null);
    assert.equal(result.sessionId, 'sess-ping');
    assert.equal(result.isResult, false);
    assert.equal(result.usage, null);
    assert.equal(result.costUsd, null);
  });
});
