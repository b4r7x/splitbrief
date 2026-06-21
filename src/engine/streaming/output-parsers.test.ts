import { describe, it, expect } from 'vitest';
import { parseTextLine } from './parse-text.js';
import { parseJsonlLine } from './parse-jsonl.js';
import { parseOpencodeLine } from './parse-opencode.js';
import { accumulateUsage } from './token-usage.js';

describe('parseTextLine', () => {
  it('returns empty for blank line', () => {
    expect(parseTextLine('')).toEqual({});
    expect(parseTextLine('   ')).toEqual({});
  });

  it('extracts token usage with k suffix', () => {
    const result = parseTextLine('Tokens: 1.5k sent, 0.8k received');
    expect(result.usage).toEqual({ inputTokens: 1500, outputTokens: 800 });
  });

  it('extracts token usage with plain numbers', () => {
    const result = parseTextLine('Tokens: 150 sent, 80 received');
    expect(result.usage).toEqual({ inputTokens: 150, outputTokens: 80 });
  });

  it('is case-insensitive for token matching', () => {
    const result = parseTextLine('TOKENS: 2K SENT, 1K RECEIVED');
    expect(result.usage).toEqual({ inputTokens: 2000, outputTokens: 1000 });
  });

  it('handles fractional k values with rounding', () => {
    const result = parseTextLine('Tokens: 0.1k sent, 0.05k received');
    expect(result.usage).toEqual({ inputTokens: 100, outputTokens: 50 });
  });

  it('does not match partial token lines (missing received)', () => {
    const result = parseTextLine('Tokens: 1.5k sent');
    expect(result.usage).toBeUndefined();
    expect(result.text).toBe('Tokens: 1.5k sent\n');
    expect(result.channel).toBe('stdout');
  });

  it('handles token line with surrounding whitespace', () => {
    const result = parseTextLine('  Tokens:  500  sent,  200  received  ');
    expect(result.usage).toEqual({ inputTokens: 500, outputTokens: 200 });
  });

  it('handles large plain token numbers', () => {
    const result = parseTextLine('Tokens: 128000 sent, 4096 received');
    expect(result.usage).toEqual({ inputTokens: 128000, outputTokens: 4096 });
  });
});

describe('parseJsonlLine', () => {
  it('returns empty for blank line', () => {
    expect(parseJsonlLine('')).toEqual({});
    expect(parseJsonlLine('  ')).toEqual({});
  });

  it('parses item.completed with text content array', () => {
    const event = {
      type: 'item.completed',
      item: {
        type: 'agent_message',
        content: [
          { type: 'text', text: 'hello' },
          { type: 'output_text', text: ' world' },
        ],
      },
    };
    const result = parseJsonlLine(JSON.stringify(event));
    expect(result.text).toBe('hello world');
    expect(result.channel).toBe('assistant');
  });

  it('parses item.completed with item.text string', () => {
    const event = {
      type: 'item.completed',
      item: { type: 'agent_message', content: [], text: 'fallback text' },
    };
    const result = parseJsonlLine(JSON.stringify(event));
    expect(result.text).toBe('fallback text');
    expect(result.channel).toBe('assistant');
  });

  it('parses turn.completed with usage (input_tokens/output_tokens)', () => {
    const event = { type: 'turn.completed', usage: { input_tokens: 100, output_tokens: 50 } };
    const result = parseJsonlLine(JSON.stringify(event));
    expect(result.usage).toEqual({ inputTokens: 100, outputTokens: 50 });
  });

  it('parses turn.completed with usage (prompt_tokens/completion_tokens)', () => {
    const event = { type: 'turn.completed', usage: { prompt_tokens: 200, completion_tokens: 75 } };
    const result = parseJsonlLine(JSON.stringify(event));
    expect(result.usage).toEqual({ inputTokens: 200, outputTokens: 75 });
  });

  it('returns text from event.text field', () => {
    const event = { text: 'some text' };
    const result = parseJsonlLine(JSON.stringify(event));
    expect(result.text).toBe('some text');
    expect(result.channel).toBe('assistant');
  });

  it('returns text from event.content string field', () => {
    const event = { content: 'content string' };
    const result = parseJsonlLine(JSON.stringify(event));
    expect(result.text).toBe('content string');
  });

  it('returns a bounded warning for invalid JSON', () => {
    expect(parseJsonlLine('not json {{')).toEqual({
      warning: [{ code: 'malformed_jsonl', message: 'Malformed JSONL line skipped' }],
    });
  });

  it('JSON-stringifies non-string content field', () => {
    const event = { content: { key: 'value' } };
    const result = parseJsonlLine(JSON.stringify(event));
    expect(result.text).toBe('{"key":"value"}');
  });

  it('parses Codex command item lifecycle events', () => {
    const started = parseJsonlLine(
      JSON.stringify({
        type: 'item.started',
        item: { id: 'cmd-1', type: 'command_execution', command: 'npm test' },
      }),
    );
    const completed = parseJsonlLine(
      JSON.stringify({
        type: 'item.completed',
        item: {
          id: 'cmd-1',
          type: 'command_execution',
          command: 'npm test',
          output: 'ok',
          status: 'completed',
        },
      }),
    );

    expect(started).toEqual({
      toolUseStart: [
        {
          id: 'cmd-1',
          name: 'command_execution',
          input: { type: 'command_execution', command: 'npm test' },
        },
      ],
    });
    expect(completed).toEqual({
      toolUseDone: [
        {
          id: 'cmd-1',
          name: 'command_execution',
          input: { type: 'command_execution', command: 'npm test', status: 'completed' },
          output: 'ok',
        },
      ],
    });
  });

  it('parses Codex file, MCP, web, and plan action items', () => {
    expect(
      parseJsonlLine(
        JSON.stringify({
          type: 'item.completed',
          item: { id: 'file-1', type: 'file_change', path: 'src/app.ts', status: 'completed' },
        }),
      ),
    ).toEqual({
      toolUseDone: [
        {
          id: 'file-1',
          name: 'file_change',
          input: { type: 'file_change', path: 'src/app.ts', status: 'completed' },
          output: 'completed',
        },
      ],
    });
    expect(
      parseJsonlLine(
        JSON.stringify({
          type: 'item.completed',
          item: {
            id: 'mcp-1',
            type: 'mcp_tool_call',
            server: 'github',
            tool_name: 'list_issues',
            input: { owner: 'acme' },
          },
        }),
      ),
    ).toEqual({
      toolUseDone: [
        {
          id: 'mcp-1',
          name: 'mcp_tool_call',
          input: {
            owner: 'acme',
            type: 'mcp_tool_call',
            server: 'github',
            tool_name: 'list_issues',
          },
        },
      ],
    });
    expect(
      parseJsonlLine(
        JSON.stringify({
          type: 'item.completed',
          item: { id: 'web-1', type: 'web_search', query: 'codex jsonl' },
        }),
      ),
    ).toEqual({
      toolUseDone: [
        {
          id: 'web-1',
          name: 'web_search',
          input: { type: 'web_search', query: 'codex jsonl' },
        },
      ],
    });
    expect(
      parseJsonlLine(
        JSON.stringify({
          type: 'item.completed',
          item: { id: 'plan-1', type: 'plan_update', text: '1. inspect\n2. edit' },
        }),
      ),
    ).toEqual({
      toolUseDone: [
        {
          id: 'plan-1',
          name: 'plan_update',
          input: { type: 'plan_update' },
          output: '1. inspect\n2. edit',
        },
      ],
    });
  });

  it('preserves Codex envelope fields when explicit input exists', () => {
    expect(
      parseJsonlLine(
        JSON.stringify({
          type: 'item.started',
          item: {
            id: 'cmd-2',
            type: 'command_execution',
            command: 'npm run lint',
            input: { cwd: '/tmp/project' },
          },
        }),
      ),
    ).toEqual({
      toolUseStart: [
        {
          id: 'cmd-2',
          name: 'command_execution',
          input: { cwd: '/tmp/project', type: 'command_execution', command: 'npm run lint' },
        },
      ],
    });
  });

  it('ignores item.completed with unrecognized non-agent_message type', () => {
    const event = {
      type: 'item.completed',
      item: { type: '', content: [{ type: 'text', text: 'should skip' }] },
    };
    const result = parseJsonlLine(JSON.stringify(event));
    expect(result.text).toBeUndefined();
  });

  it('falls back to item.text when content array has no text blocks', () => {
    const event = {
      type: 'item.completed',
      item: {
        type: 'agent_message',
        content: [{ type: 'image', url: 'http://example.com' }],
        text: 'fallback',
      },
    };
    const result = parseJsonlLine(JSON.stringify(event));
    expect(result.text).toBe('fallback');
  });

  it('returns empty for item.completed with empty content and no item.text', () => {
    const event = {
      type: 'item.completed',
      item: { type: 'agent_message', content: [] },
    };
    const result = parseJsonlLine(JSON.stringify(event));
    expect(result).toEqual({});
  });

  it('skips content blocks with empty text', () => {
    const event = {
      type: 'item.completed',
      item: {
        type: 'agent_message',
        content: [
          { type: 'text', text: '' },
          { type: 'text', text: 'real text' },
        ],
      },
    };
    const result = parseJsonlLine(JSON.stringify(event));
    expect(result.text).toBe('real text');
  });

  it('prefers input_tokens over prompt_tokens when both present', () => {
    const event = {
      type: 'turn.completed',
      usage: { input_tokens: 100, prompt_tokens: 999, output_tokens: 50, completion_tokens: 888 },
    };
    const result = parseJsonlLine(JSON.stringify(event));
    expect(result.usage).toEqual({ inputTokens: 100, outputTokens: 50 });
  });

  it('returns empty for turn.completed without usage', () => {
    const event = { type: 'turn.completed' };
    const result = parseJsonlLine(JSON.stringify(event));
    expect(result).toEqual({});
  });

  it('returns empty for event with no recognizable fields', () => {
    const event = { type: 'unknown', metadata: {} };
    const result = parseJsonlLine(JSON.stringify(event));
    expect(result).toEqual({});
  });
});

describe('parseOpencodeLine', () => {
  it('returns empty for blank line', () => {
    expect(parseOpencodeLine('')).toEqual({});
    expect(parseOpencodeLine('   ')).toEqual({});
  });

  it('parses text part from the real envelope', () => {
    const event = {
      type: 'text',
      timestamp: 1781345484606,
      sessionID: 'ses_13f89223effeq85h7RlKmjsV3M',
      part: {
        id: 'prt_ec076ff1800121yroOznZEpT7r',
        sessionID: 'ses_13f89223effeq85h7RlKmjsV3M',
        messageID: 'msg_ec076de2d001eIfRD5tzzP0L6w',
        type: 'text',
        text: 'a.js, err.txt, out.txt\n\ndone',
        time: { start: 1781345484605, end: 1781345484605 },
      },
    };
    const result = parseOpencodeLine(JSON.stringify(event));
    expect(result.text).toBe('a.js, err.txt, out.txt\n\ndone');
    expect(result.channel).toBe('assistant');
    expect(result.sessionId).toBe('ses_13f89223effeq85h7RlKmjsV3M');
  });

  it('parses step_finish usage from part.tokens', () => {
    const event = {
      type: 'step_finish',
      timestamp: 1781345484609,
      sessionID: 'ses_13f89223effeq85h7RlKmjsV3M',
      part: {
        id: 'prt_ec076ff3f001seD4fnNJbMtL5k',
        sessionID: 'ses_13f89223effeq85h7RlKmjsV3M',
        messageID: 'msg_ec076de2d001eIfRD5tzzP0L6w',
        type: 'step-finish',
        reason: 'stop',
        cost: 0.1121604,
        tokens: {
          total: 64362,
          input: 64328,
          output: 34,
          reasoning: 32,
          cache: { read: 0, write: 0 },
        },
      },
    };
    const result = parseOpencodeLine(JSON.stringify(event));
    expect(result.usage).toEqual({
      inputTokens: 64328,
      outputTokens: 34,
      cacheReadTokens: 0,
      cacheCreateTokens: 0,
    });
    expect(result.sessionId).toBe('ses_13f89223effeq85h7RlKmjsV3M');
  });

  it('returns empty for invalid JSON', () => {
    expect(parseOpencodeLine('broken')).toEqual({});
  });

  it('keeps session ids on otherwise ignored step_start events', () => {
    const stepStart = {
      type: 'step_start',
      timestamp: 1781345478338,
      sessionID: 'ses_13f89223effeq85h7RlKmjsV3M',
      part: {
        id: 'prt_ec076e6c1001DVcresNhfJy8i2',
        sessionID: 'ses_13f89223effeq85h7RlKmjsV3M',
        messageID: 'msg_ec076de2d001eIfRD5tzzP0L6w',
        type: 'step-start',
      },
    };
    expect(parseOpencodeLine(JSON.stringify(stepStart))).toEqual({
      sessionId: 'ses_13f89223effeq85h7RlKmjsV3M',
    });
  });

  it('captures tool-use envelopes', () => {
    expect(
      parseOpencodeLine(
        JSON.stringify({
          type: 'tool_use',
          sessionID: 'ses_tool',
          part: {
            type: 'tool',
            id: 'tool-opencode',
            name: 'read_file',
            input: { path: 'src/a.ts' },
          },
        }),
      ),
    ).toEqual({
      sessionId: 'ses_tool',
      toolUseStart: [{ id: 'tool-opencode', name: 'read_file', input: { path: 'src/a.ts' } }],
    });
  });

  it('captures completed tool envelopes', () => {
    expect(
      parseOpencodeLine(
        JSON.stringify({
          type: 'tool_result',
          sessionID: 'ses_tool',
          part: {
            type: 'tool',
            id: 'tool-opencode',
            name: 'read_file',
            input: { path: 'src/a.ts' },
            output: 'contents',
          },
        }),
      ),
    ).toEqual({
      sessionId: 'ses_tool',
      toolUseDone: [
        {
          id: 'tool-opencode',
          name: 'read_file',
          input: { path: 'src/a.ts' },
          output: 'contents',
        },
      ],
    });
  });

  it('ignores the legacy top-level text/usage shapes that opencode never emits', () => {
    expect(parseOpencodeLine(JSON.stringify({ type: 'text', text: 'generated code' }))).toEqual({});
    expect(
      parseOpencodeLine(
        JSON.stringify({ type: 'step_finish', usage: { tokens: { input: 500, output: 200 } } }),
      ),
    ).toEqual({});
  });
});

describe('accumulateUsage', () => {
  it('returns delta when current is null', () => {
    const delta = { inputTokens: 100, outputTokens: 50 };
    const result = accumulateUsage(null, delta);
    expect(result).toEqual({ inputTokens: 100, outputTokens: 50 });
    expect(result).not.toBe(delta);
  });

  it('adds delta to existing current', () => {
    const current = { inputTokens: 100, outputTokens: 50 };
    const delta = { inputTokens: 200, outputTokens: 75 };
    expect(accumulateUsage(current, delta)).toEqual({ inputTokens: 300, outputTokens: 125 });
  });

  it('chains multiple accumulations correctly', () => {
    let usage = accumulateUsage(null, { inputTokens: 100, outputTokens: 50 });
    usage = accumulateUsage(usage, { inputTokens: 200, outputTokens: 100 });
    usage = accumulateUsage(usage, { inputTokens: 50, outputTokens: 25 });
    expect(usage).toEqual({ inputTokens: 350, outputTokens: 175 });
  });

  it('handles zero-value deltas', () => {
    const current = { inputTokens: 100, outputTokens: 50 };
    expect(accumulateUsage(current, { inputTokens: 0, outputTokens: 0 })).toEqual({
      inputTokens: 100,
      outputTokens: 50,
    });
  });
});
