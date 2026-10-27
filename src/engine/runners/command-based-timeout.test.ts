import { describe, expect, it } from 'vitest';
import { DEFAULT_PROCESS_LINE_MAX_BYTES } from '../../lib/process/spawn/lifecycle.js';
import type { RunnerCallEvent } from '../calls/types.js';
import { invokeCommandRunner, type CommandRunnerOptions } from './command-based.js';

type ConfigRunner = Extract<CommandRunnerOptions['source'], { kind: 'config' }>['runner'];

function run(
  runner: ConfigRunner,
  extra: Partial<Omit<CommandRunnerOptions, 'source'>> = {},
  env: NodeJS.ProcessEnv = process.env,
) {
  return invokeCommandRunner({
    source: {
      kind: 'config',
      runner,
      env,
      notFoundMessage: `Shell implementer command not found: ${runner.command}`,
    },
    prompt: '',
    cwd: process.cwd(),
    callContext: { callId: 'call-timeout', role: 'implementer', backendKind: 'shell' },
    ...extra,
  });
}

describe('invokeCommandRunner with timeout', () => {
  it('records stderr activity', async () => {
    const events: RunnerCallEvent[] = [];
    const result = await run(
      {
        command: 'sh',
        args: ['-c', 'cat >/dev/null; echo timeout-branch-progress >&2'],
      },
      {
        timeoutMs: 30_000,
        onCallEvent: (event) => events.push(event),
      },
    );

    expect(
      events.some(
        (event) =>
          event.type === 'call_stderr_delta' && event.text.includes('timeout-branch-progress'),
      ),
    ).toBe(true);
    expect(result.warnings).toEqual([]);
  });

  it('redacts credential values', async () => {
    const credential = 'timeout-branch-credential-canary-91ac';
    const events: RunnerCallEvent[] = [];
    const streamed: string[] = [];

    const result = await run(
      {
        command: 'sh',
        args: [
          '-c',
          `cat >/dev/null; echo "answer ${credential}"; echo "diagnostic ${credential}" >&2`,
        ],
      },
      {
        timeoutMs: 30_000,
        onOutput: (chunk) => streamed.push(chunk),
        onCallEvent: (event) => events.push(event),
      },
      { ...process.env, OPENAI_API_KEY: credential },
    );

    expect(streamed.join('')).toContain('***REDACTED***');
    expect(streamed.join('')).not.toContain(credential);
    expect(JSON.stringify(events)).not.toContain(credential);
    expect(JSON.stringify(result)).not.toContain(credential);
  });

  it('marks an idle kill with the no-progress-cut code', async () => {
    const events: RunnerCallEvent[] = [];

    await expect(
      run(
        {
          command: 'sleep',
          args: ['1'],
          idleWarnMs: 10,
          idleKillMs: 20,
        },
        {
          timeoutMs: 30_000,
          onCallEvent: (event) => events.push(event),
        },
      ),
    ).rejects.toThrow();

    const errorEvent = events.find((event) => event.type === 'call_error');
    expect(errorEvent).toMatchObject({
      type: 'call_error',
      error: { code: 'no-progress-cut' },
    });
  });

  it('parses stream-json through the format pipeline', async () => {
    const line = JSON.stringify({
      type: 'assistant',
      message: { content: [{ type: 'text', text: 'parsed body' }] },
    });
    const result = await run(
      {
        command: 'sh',
        args: ['-c', 'cat >/dev/null; printf "%s\n" "$1"', 'sh', line],
        outputFormat: 'stream-json',
      },
      {
        timeoutMs: 30_000,
      },
    );
    expect(result.text).toBe('parsed body');
    expect(result.text).not.toContain('assistant');
  });

  it('accumulates usage from stream-json', async () => {
    const line = JSON.stringify({
      type: 'result',
      result: 'done',
      usage: { input_tokens: 11, output_tokens: 7 },
    });
    const result = await run(
      {
        command: 'sh',
        args: ['-c', 'cat >/dev/null; printf "%s\n" "$1"', 'sh', line],
        outputFormat: 'stream-json',
      },
      {
        timeoutMs: 30_000,
      },
    );
    expect(result.text).toBe('done');
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
    const result = await run(
      {
        command: 'sh',
        args: ['-c', 'cat >/dev/null; printf "%s\n" "$1"', 'sh', lines.join('\n')],
        outputFormat: 'stream-json',
      },
      {
        onOutput: (chunk) => chunks.push(chunk),
      },
    );
    expect(result.text).toBe('final text');
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
    const result = await run(
      {
        command: 'sh',
        args: ['-c', 'cat >/dev/null; printf "%s\n" "$1"', 'sh', lines.join('\n')],
        outputFormat: 'stream-json',
      },
      {
        onOutput: (chunk) => chunks.push(chunk),
      },
    );

    expect(result.text).toBe('draft final');
    expect(chunks).toEqual(['draft', ' final']);
  });

  it('rejects a child that outlives the timeout and reports it as a timeout call error', async () => {
    const events: RunnerCallEvent[] = [];

    await expect(
      run(
        {
          command: 'sh',
          args: ['-c', 'sleep 5'],
        },
        {
          timeoutMs: 200,
          onCallEvent: (event) => events.push(event),
        },
      ),
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

    await run(
      {
        command: 'sh',
        args: ['-c', 'cat >/dev/null; printf "%s\n" "$1"', 'sh', lines.join('\n')],
        outputFormat: 'stream-json',
      },
      {
        onCallEvent: (event) => events.push(event),
      },
    );

    const deltas = events.filter((event) => event.type === 'call_tool_use_delta');
    expect(deltas).toEqual([
      expect.objectContaining({ toolUseId: 'tool-real', name: 'Read' }),
      expect.objectContaining({ toolUseId: 'tool-real', name: 'Read' }),
    ]);
  });

  it('preserves session id and tool use from stream-json', async () => {
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
        type: 'user',
        session_id: 'sess-timeout-structured',
        message: { content: [{ type: 'tool_result', tool_use_id: 'tool-timeout' }] },
      }),
      JSON.stringify({
        type: 'result',
        result: 'done',
        session_id: 'sess-timeout-structured',
        usage: { input_tokens: 11, output_tokens: 7 },
      }),
    ];
    const events: RunnerCallEvent[] = [];

    const result = await run(
      {
        command: 'sh',
        args: ['-c', 'cat >/dev/null; printf "%s\n" "$1"', 'sh', lines.join('\n')],
        outputFormat: 'stream-json',
      },
      {
        timeoutMs: 30_000,
        onCallEvent: (event) => events.push(event),
      },
    );

    expect(result.nativeSessionId).toBe('sess-timeout-structured');
    expect(result.toolUses).toEqual([
      { id: 'tool-timeout', name: 'read_file', input: { path: 'src/main.ts' } },
    ]);
    expect(events.some((event) => event.type === 'call_session_id')).toBe(true);
    expect(events.some((event) => event.type === 'call_tool_use_done')).toBe(true);
  });

  it('recovers from an unterminated oversized stdout line', async () => {
    const chunks: string[] = [];
    const result = await run(
      {
        command: 'node',
        args: [
          '-e',
          `require("node:fs").readFileSync(0);process.stdout.write("x".repeat(${DEFAULT_PROCESS_LINE_MAX_BYTES + 100}))`,
        ],
        outputFormat: 'text',
      },
      {
        timeoutMs: 30_000,
        onOutput: (chunk) => chunks.push(chunk),
      },
    );

    expect(result.text).toBe('');
    expect(chunks).toEqual([]);
    expect(result).toMatchObject({ status: 'completed' });
    expect(result.warnings).toEqual([
      expect.objectContaining({
        code: 'stdout_line_overflow',
        message: expect.stringContaining('A line of the tool output longer than'),
      }),
    ]);
  });
});
