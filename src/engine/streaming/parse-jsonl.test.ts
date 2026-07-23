import { describe, it, expect } from 'vitest';
import { parseJsonlLine } from './parse-jsonl.js';

describe('parseJsonlLine — codex liveness and failure records', () => {
  it('turn.started and item.updated are consumed silently', () => {
    expect(parseJsonlLine(JSON.stringify({ type: 'turn.started' }))).toEqual({});
    expect(
      parseJsonlLine(
        JSON.stringify({
          type: 'item.updated',
          item: { id: 'cmd-1', type: 'command_execution', status: 'in_progress' },
        }),
      ),
    ).toEqual({});
  });

  it('turn.failed and error records map to a deduplicated upstream-failure warning', () => {
    const turnFailed = parseJsonlLine(
      JSON.stringify({ type: 'turn.failed', error: { message: 'rate limited' } }),
    );
    expect(turnFailed).toEqual({
      warning: [
        expect.objectContaining({
          code: 'jsonl_upstream_failure',
          source: 'jsonl',
          parser: 'jsonl',
          upstreamType: 'turn.failed',
          fingerprint: expect.stringMatching(/^rw:/),
        }),
      ],
    });

    const errorRecord = parseJsonlLine(JSON.stringify({ type: 'error', message: 'rate limited' }));
    expect(errorRecord).toEqual({
      warning: [
        expect.objectContaining({
          code: 'jsonl_upstream_failure',
          source: 'jsonl',
          parser: 'jsonl',
          upstreamType: 'error',
          fingerprint: expect.stringMatching(/^rw:/),
        }),
      ],
    });

    const repeat = parseJsonlLine(
      JSON.stringify({ type: 'turn.failed', error: { message: 'rate limited' } }),
    );
    expect(repeat.warning?.[0]?.fingerprint).toBe(turnFailed.warning?.[0]?.fingerprint);
  });

  it('unknown record types still produce the deduplicated unknown-record warning', () => {
    const first = parseJsonlLine(JSON.stringify({ type: 'mystery.event', payload: 1 }));
    const second = parseJsonlLine(JSON.stringify({ type: 'mystery.event', payload: 2 }));

    expect(first).toEqual({
      warning: [
        expect.objectContaining({
          code: 'unknown_jsonl_record',
          source: 'jsonl',
          parser: 'jsonl',
          upstreamType: 'mystery.event',
          fingerprint: expect.stringMatching(/^rw:/),
        }),
      ],
    });
    expect(second.warning?.[0]?.fingerprint).toBe(first.warning?.[0]?.fingerprint);
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
    expect(result.usageSemantics).toBe('final');
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
      warning: [
        expect.objectContaining({
          code: 'malformed_jsonl',
          source: 'jsonl',
          parser: 'jsonl',
          upstreamType: 'malformed_json',
          channel: 'stdout',
          message: expect.stringContaining('Malformed jsonl record'),
          fingerprint: expect.stringMatching(/^rw:/),
        }),
      ],
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

  it('returns a bounded warning for event with no recognizable fields', () => {
    const event = { type: 'unknown', metadata: {} };
    const result = parseJsonlLine(JSON.stringify(event));
    expect(result).toEqual({
      warning: [
        expect.objectContaining({
          code: 'unknown_jsonl_record',
          source: 'jsonl',
          parser: 'jsonl',
          upstreamType: 'unknown',
          channel: 'stdout',
        }),
      ],
    });
  });
});
