import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DEFAULT_PROCESS_LINE_MAX_BYTES } from '../../lib/process/spawn/lifecycle.js';
import type { RunnerCallEvent } from '../calls/types.js';
import { invokeCommandBasedRunner } from './command-based.js';
import {
  admittedCustomRunner,
  customRunner,
  observeCustomInvocation,
} from '#testing/helpers/custom-command-based.js';
import { withTempDir } from '#testing/helpers/temp-dir.js';

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

  it('marks an idle kill on the timeout branch with the runner_idle_timeout code', async () => {
    const events: RunnerCallEvent[] = [];

    await expect(
      invokeCommandBasedRunner({
        command: 'sh',
        args: ['-c', 'sleep 1'],
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
      error: { code: 'runner_idle_timeout' },
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

describe('custom runner hard deadline', () => {
  it('enforces a short hard deadline through the typed test seam', {
    timeout: 30_000,
  }, async () => {
    const output: string[] = [];
    const observation = await observeCustomInvocation(
      {
        admission: await admittedCustomRunner(
          process.cwd(),
          customRunner({
            argv: [
              '-e',
              'process.stdout.write("started\\n");setInterval(() => process.stdout.write("chatty\\n"), 10);',
            ],
          }),
        ),
        prompt: '',
        authorizationProjectDir: process.cwd(),
        cwd: process.cwd(),
        sourceEnv: {},
      },
      (kind, value) => {
        if (kind === 'output') output.push(value);
      },
      { hardDeadlineMs: 10_000 },
    );

    expect(output.join('')).toContain('started');
    expect(observation.result).toBeUndefined();
    expect(observation.failure).toMatchObject({ kind: 'command-timeout' });
    expect(observation.events).toContainEqual(
      expect.objectContaining({
        type: 'call_error',
        status: 'timeout',
        error: expect.objectContaining({ code: 'command-timeout' }),
      }),
    );
  });

  it('terminates a timed-out custom child before its delayed side effect can run', {
    timeout: 30_000,
  }, async () => {
    await withTempDir('custom runner deadline cleanup', async (projectDir) => {
      const delayedEffect = join(projectDir, 'late-child-effect');
      const observation = await observeCustomInvocation(
        {
          admission: await admittedCustomRunner(
            projectDir,
            customRunner({
              argv: [
                '-e',
                [
                  'const fs = require("node:fs");',
                  'process.stdout.write("started\\n");',
                  `setTimeout(() => fs.writeFileSync(${JSON.stringify(delayedEffect)}, "late"), 1_000);`,
                  'setInterval(() => undefined, 1_000);',
                ].join(''),
              ],
            }),
          ),
          prompt: '',
          authorizationProjectDir: projectDir,
          cwd: projectDir,
          sourceEnv: {},
        },
        undefined,
        { hardDeadlineMs: 300 },
      );

      expect(observation.result).toBeUndefined();
      expect(observation.failure).toMatchObject({ kind: 'command-timeout' });
      expect(existsSync(delayedEffect)).toBe(false);
    });
  });
});
