import { describe, expect, it } from 'vitest';
import { DEFAULT_PROCESS_LINE_MAX_BYTES } from '../../lib/process/spawn/lifecycle.js';
import type { RunnerCallEvent } from '../calls/types.js';
import { invokeCommandBasedRunner } from './command-based.js';

describe('invokeCommandBasedRunner with timeout', () => {
  it('records stderr activity on the timeout branch', async () => {
    const events: RunnerCallEvent[] = [];
    const result = await invokeCommandBasedRunner({
      command: 'sh',
      args: ['-c', 'echo timeout-branch-progress >&2'],
      timeout: 30_000,
      prompt: '',
      projectDir: process.cwd(),
      onCallEvent: (event) => events.push(event),
    });

    expect(result.stderr).toContain('timeout-branch-progress');
    expect(
      events.some(
        (event) =>
          event.type === 'call_stderr_delta' && event.text.includes('timeout-branch-progress'),
      ),
    ).toBe(true);
    expect(result.callResult.warnings).toEqual([]);
  });

  it('redacts credential values on the timeout branch', async () => {
    const credential = 'timeout-branch-credential-canary-91ac';
    const events: RunnerCallEvent[] = [];
    const streamed: string[] = [];

    const result = await invokeCommandBasedRunner({
      command: 'sh',
      args: ['-c', `echo "answer ${credential}"; echo "diagnostic ${credential}" >&2`],
      env: { ...process.env, OPENAI_API_KEY: credential },
      timeout: 30_000,
      prompt: '',
      projectDir: process.cwd(),
      onOutput: (chunk) => streamed.push(chunk),
      onCallEvent: (event) => events.push(event),
    });

    expect(streamed.join('')).toContain('***REDACTED***');
    expect(streamed.join('')).not.toContain(credential);
    expect(JSON.stringify(events)).not.toContain(credential);
    expect(JSON.stringify(result.callResult)).not.toContain(credential);
  });

  it('marks an idle kill on the timeout branch with the no-progress-cut code', async () => {
    const events: RunnerCallEvent[] = [];

    await expect(
      invokeCommandBasedRunner({
        command: 'sleep',
        args: ['1'],
        timeout: 30_000,
        idleWarnMs: 10,
        idleKillMs: 20,
        prompt: '',
        projectDir: process.cwd(),
        onCallEvent: (event) => events.push(event),
      }),
    ).rejects.toThrow();

    const errorEvent = events.find((event) => event.type === 'call_error');
    expect(errorEvent).toMatchObject({
      type: 'call_error',
      error: { code: 'no-progress-cut' },
    });
  });

  it('parses stream-json through the format pipeline on the timeout branch', async () => {
    const line = JSON.stringify({
      type: 'assistant',
      message: { content: [{ type: 'text', text: 'parsed body' }] },
    });
    const result = await invokeCommandBasedRunner({
      command: 'printf',
      args: ['%s\\n', line],
      outputFormat: 'stream-json',
      timeout: 30_000,
      prompt: '',
      projectDir: process.cwd(),
    });
    expect(result.stdout).toBe('parsed body');
    expect(result.stdout).not.toContain('assistant');
  });

  it('accumulates usage from stream-json on the timeout branch', async () => {
    const line = JSON.stringify({
      type: 'result',
      result: 'done',
      usage: { input_tokens: 11, output_tokens: 7 },
    });
    const result = await invokeCommandBasedRunner({
      command: 'printf',
      args: ['%s\\n', line],
      outputFormat: 'stream-json',
      timeout: 30_000,
      prompt: '',
      projectDir: process.cwd(),
    });
    expect(result.stdout).toBe('done');
    expect(result.usage).toEqual({
      inputTokens: 11,
      outputTokens: 7,
      counterCoverage: {
        input: 'reported',
        output: 'partial',
        cacheRead: 'missing',
        cacheCreate: 'missing',
        reasoning: 'missing',
      },
      providerTotals: { output: 7 },
    });
  });

  it('uses final stream-json result text instead of assistant draft text', async () => {
    const chunks: string[] = [];
    const lines = [
      JSON.stringify({
        type: 'assistant',
        message: { content: [{ type: 'text', text: 'draft text' }] },
      }),
      JSON.stringify({
        type: 'result',
        result: 'final text',
        usage: { input_tokens: 11, output_tokens: 7 },
      }),
    ];
    const result = await invokeCommandBasedRunner({
      command: 'printf',
      args: ['%s\\n', lines.join('\n')],
      outputFormat: 'stream-json',
      prompt: '',
      projectDir: process.cwd(),
      onOutput: (chunk) => chunks.push(chunk),
    });
    expect(result.stdout).toBe('final text');
    expect(result.callResult.text).toBe('final text');
    expect(chunks).toEqual(['draft text']);
  });

  it('streams only the missing suffix when stream-json final text extends assistant text', async () => {
    const chunks: string[] = [];
    const lines = [
      JSON.stringify({
        type: 'assistant',
        message: { content: [{ type: 'text', text: 'draft' }] },
      }),
      JSON.stringify({
        type: 'result',
        result: 'draft final',
      }),
    ];
    const result = await invokeCommandBasedRunner({
      command: 'printf',
      args: ['%s\\n', lines.join('\n')],
      outputFormat: 'stream-json',
      prompt: '',
      projectDir: process.cwd(),
      onOutput: (chunk) => chunks.push(chunk),
    });

    expect(result.stdout).toBe('draft final');
    expect(chunks).toEqual(['draft', ' final']);
  });

  it('rejects a child that outlives the timeout and reports it as a timeout call error', async () => {
    const events: RunnerCallEvent[] = [];

    await expect(
      invokeCommandBasedRunner({
        command: 'sh',
        args: ['-c', 'sleep 5'],
        timeout: 200,
        prompt: '',
        projectDir: process.cwd(),
        onCallEvent: (event) => events.push(event),
      }),
    ).rejects.toMatchObject({ kind: 'command-timeout' });

    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'call_error',
        status: 'timeout',
        error: expect.objectContaining({ code: 'command-timeout' }),
      }),
    );
  });

  it('keeps one tool-use id and name across stream-json start and input deltas', async () => {
    const lines = [
      JSON.stringify({
        type: 'stream_event',
        event: {
          type: 'content_block_start',
          content_block: { type: 'tool_use', id: 'tool-real', name: 'Read', input: {} },
        },
      }),
      JSON.stringify({
        type: 'stream_event',
        event: {
          type: 'content_block_delta',
          index: 1,
          delta: { type: 'input_json_delta', partial_json: '{"file_path":"src/app.ts"}' },
        },
      }),
      JSON.stringify({
        type: 'result',
        result: 'done',
        usage: { input_tokens: 1, output_tokens: 1 },
      }),
    ];
    const events: RunnerCallEvent[] = [];

    await invokeCommandBasedRunner({
      command: 'printf',
      args: ['%s\\n', lines.join('\n')],
      outputFormat: 'stream-json',
      prompt: '',
      projectDir: process.cwd(),
      onCallEvent: (event) => events.push(event),
    });

    const deltas = events.filter((event) => event.type === 'call_tool_use_delta');
    expect(deltas).toEqual([
      expect.objectContaining({ toolUseId: 'tool-real', name: 'Read' }),
      expect.objectContaining({ toolUseId: 'tool-real', name: 'Read' }),
    ]);
  });

  it('preserves session id and tool use from stream-json on the timeout branch', async () => {
    const lines = [
      JSON.stringify({
        type: 'assistant',
        session_id: 'sess-timeout-structured',
        message: {
          content: [
            {
              type: 'tool_use',
              id: 'tool-timeout',
              name: 'read_file',
              input: { path: 'src/main.ts' },
            },
            { type: 'text', text: 'read complete' },
          ],
        },
      }),
      JSON.stringify({
        type: 'result',
        result: 'done',
        session_id: 'sess-timeout-structured',
        usage: { input_tokens: 11, output_tokens: 7 },
      }),
    ];
    const events: RunnerCallEvent[] = [];
    const sessionIds: string[] = [];

    const result = await invokeCommandBasedRunner({
      command: 'printf',
      args: ['%s\\n', lines.join('\n')],
      outputFormat: 'stream-json',
      timeout: 30_000,
      prompt: '',
      projectDir: process.cwd(),
      onSessionId: (id) => sessionIds.push(id),
      onCallEvent: (event) => events.push(event),
    });

    expect(result.callResult.nativeSessionId).toBe('sess-timeout-structured');
    expect(sessionIds).toEqual(['sess-timeout-structured']);
    expect(result.callResult.toolUses).toEqual([
      { id: 'tool-timeout', name: 'read_file', input: { path: 'src/main.ts' } },
    ]);
    expect(events.some((event) => event.type === 'call_session_id')).toBe(true);
    expect(events.some((event) => event.type === 'call_tool_use_done')).toBe(true);
  });

  it('recovers from an unterminated oversized stdout line on the timeout branch', async () => {
    const chunks: string[] = [];
    const result = await invokeCommandBasedRunner({
      command: 'node',
      args: ['-e', `process.stdout.write("x".repeat(${DEFAULT_PROCESS_LINE_MAX_BYTES + 100}))`],
      outputFormat: 'text',
      timeout: 30_000,
      prompt: '',
      projectDir: process.cwd(),
      onOutput: (chunk) => chunks.push(chunk),
    });

    expect(result.stdout).toBe('');
    expect(chunks).toEqual([]);
    expect(result.callResult).toMatchObject({ status: 'completed' });
    expect(result.callResult.warnings).toEqual([
      expect.objectContaining({
        code: 'stdout_line_overflow',
        message: expect.stringContaining('stdout line exceeded'),
      }),
    ]);
  });
});
