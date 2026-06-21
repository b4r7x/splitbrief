import { describe, expect, it } from 'vitest';
import {
  DEFAULT_PROCESS_LINE_MAX_BYTES,
  DEFAULT_PROCESS_STDERR_MAX_BYTES,
} from '../../lib/process/spawn.js';
import type { RunnerCallEvent } from '../calls/types.js';
import { invokeCommandBasedRunner } from './command-based.js';

describe('invokeCommandBasedRunner', () => {
  it('writes prompt to stdin when no placeholder present', async () => {
    const result = await invokeCommandBasedRunner({
      command: 'cat',
      prompt: 'test prompt',
      projectDir: process.cwd(),
    });
    expect(result.stdout).toContain('test prompt');
  });

  it('substitutes {prompt} placeholder in args', async () => {
    const result = await invokeCommandBasedRunner({
      command: 'echo',
      args: ['{prompt}'],
      supportPromptPlaceholder: true,
      prompt: 'hello world',
      projectDir: process.cwd(),
    });
    expect(result.stdout.trim()).toBe('hello world');
  });

  it('substitutes {prompt} placeholder in command', async () => {
    const result = await invokeCommandBasedRunner({
      command: 'sh',
      args: ['-c', 'echo "{prompt}"'],
      supportPromptPlaceholder: true,
      prompt: 'substituted text',
      projectDir: process.cwd(),
    });
    expect(result.stdout.trim()).toBe('substituted text');
  });

  it('keeps $-replacement patterns in the prompt inert', async () => {
    const prompt = 'a $& b $$ c $` d';
    const result = await invokeCommandBasedRunner({
      command: 'printf',
      args: ['%s', '{prompt}'],
      supportPromptPlaceholder: true,
      prompt,
      projectDir: process.cwd(),
    });
    expect(result.stdout.trim()).toBe(prompt);
  });

  it('substitutes every {prompt} occurrence in an arg', async () => {
    const result = await invokeCommandBasedRunner({
      command: 'printf',
      args: ['%s', '{prompt}-{prompt}'],
      supportPromptPlaceholder: true,
      prompt: 'x',
      projectDir: process.cwd(),
    });
    expect(result.stdout.trim()).toBe('x-x');
  });

  it('uses stdin when supportPromptPlaceholder is false', async () => {
    const result = await invokeCommandBasedRunner({
      command: 'cat',
      args: [],
      supportPromptPlaceholder: false,
      prompt: 'stdin content',
      projectDir: process.cwd(),
    });
    expect(result.stdout).toContain('stdin content');
  });

  it('returns stdout without extracting code', async () => {
    const codeBlock = '```js\nconsole.log("hi")\n```';
    const result = await invokeCommandBasedRunner({
      command: 'echo',
      args: [codeBlock],
      prompt: '',
      projectDir: process.cwd(),
    });
    expect(result.stdout).toContain('console.log');
  });

  it('propagates command-not-found error', async () => {
    await expect(
      invokeCommandBasedRunner({
        command: 'nonexistent-command-xyz',
        prompt: 'prompt',
        projectDir: process.cwd(),
      }),
    ).rejects.toThrow(/Command not found/);
  });

  it('streams stdout chunks to the output subscriber', async () => {
    const chunks: string[] = [];
    await invokeCommandBasedRunner({
      command: 'echo',
      args: ['hello'],
      prompt: '',
      projectDir: process.cwd(),
      onOutput: (text: string) => {
        chunks.push(text);
      },
    });
    expect(chunks.length).toBeGreaterThan(0);
    expect(chunks.join('')).toContain('hello');
  });

  it('captures stderr', async () => {
    const result = await invokeCommandBasedRunner({
      command: 'sh',
      args: ['-c', 'echo error >&2'],
      prompt: '',
      projectDir: process.cwd(),
    });
    expect(result.stderr).toContain('error');
  });

  it('returns bounded stderr on the non-timeout branch', async () => {
    const result = await invokeCommandBasedRunner({
      command: 'node',
      args: [
        '-e',
        [
          'process.stderr.write("stderr-head\\n");',
          'process.stderr.write("x".repeat(2 * 1024 * 1024));',
          'process.stderr.write("\\nstderr-tail\\n");',
        ].join(''),
      ],
      prompt: '',
      projectDir: process.cwd(),
    });

    expect(Buffer.byteLength(result.stderr, 'utf8')).toBeLessThanOrEqual(
      DEFAULT_PROCESS_STDERR_MAX_BYTES,
    );
    expect(result.stderr).toContain('output truncated');
    expect(result.stderr).toContain('stderr-tail');
    expect(result.stderr).not.toContain('stderr-head');
    expect(result.stderr).not.toContain('x'.repeat(1024 * 1024));
  });

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

  it('returns stdout and stderr', async () => {
    const result = await invokeCommandBasedRunner({
      command: 'echo',
      args: ['output'],
      prompt: '',
      projectDir: process.cwd(),
    });
    expect(result.stdout).toContain('output');
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
    expect(result.usage).toEqual({ inputTokens: 11, outputTokens: 7 });
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

  it('uses final stream-json result text instead of assistant draft text on the timeout branch', async () => {
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
      timeout: 30_000,
      prompt: '',
      projectDir: process.cwd(),
      onOutput: (chunk) => chunks.push(chunk),
    });
    expect(result.stdout).toBe('final text');
    expect(result.callResult.text).toBe('final text');
    expect(chunks).toEqual(['draft text']);
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

  it('bounds timeout-branch live stdout lines before parsing', async () => {
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
    expect(result.callResult).toMatchObject({
      status: 'truncated',
      error: { code: 'stdout_line_overflow' },
    });
    expect(result.callResult.warnings).toEqual([
      expect.objectContaining({
        code: 'stdout_line_overflow',
        message: expect.stringContaining('stdout line exceeded'),
      }),
    ]);
  });
});
