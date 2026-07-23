import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { runClaudePlannerStream } from './invoke.js';
import { DEFAULT_PROCESS_LINE_MAX_BYTES } from '../../../lib/process/spawn/lifecycle.js';
import { RUNNER_CALL_OUTPUT_MAX_EVENTS } from '../../calls/output-limit.js';
import { createTempDir, cleanupTempDir } from '#testing/helpers/temp-dir.js';
import type { RunnerCallEvent } from '../../calls/types.js';
import {
  replayRunnerCallEventsIntoOperations,
  runnerCallErrors,
  runnerCallTerminals,
} from '#testing/helpers/runner-call-events.js';
import { prependPath } from '#testing/helpers/command-shim.js';
import {
  installClaudeFailingShim,
  installClaudeNodeShim,
  installClaudeRecordingShim,
  installClaudeShim,
  installClaudeSlowShim,
  makeClaudeTestImage,
} from '#testing/helpers/claude-cli-shim.js';

/**
 * These tests exercise the real subprocess seam. `claude/invoke.ts` hardcodes
 * `command: 'claude'`; we intercept by installing a shim named `claude` in a
 * temp directory and prepending that directory to PATH for the duration of
 * each test. The shim emits real stream-json lines so the invoke module's
 * parse + state-aggregation path is observable end-to-end.
 */

let shimDir: string;
let restorePath: () => void;

beforeEach(() => {
  shimDir = createTempDir('claude-runner-shim');
  restorePath = prependPath(shimDir);
});

afterEach(() => {
  restorePath();
  cleanupTempDir(shimDir);
});

describe('runClaudePlannerStream', () => {
  it('accumulates streamed text and captures session id + usage from result event', async () => {
    installClaudeShim(shimDir, [
      '{"type":"system","session_id":"sess-abc"}',
      '{"type":"assistant","message":{"content":[{"type":"text","text":"Hello "}]}}',
      '{"type":"assistant","message":{"content":[{"type":"text","text":"world"}]}}',
      '{"type":"result","result":"Hello world","session_id":"sess-abc","usage":{"input_tokens":42,"output_tokens":7}}',
    ]);

    const chunks: string[] = [];
    const result = await runClaudePlannerStream({
      prompt: 'do thing',
      projectDir: shimDir,
      sessionId: null,
      onOutput: (text) => chunks.push(text),
    });

    expect(result.sessionId).toBe('sess-abc');
    expect(result.usage).toEqual({ inputTokens: 42, outputTokens: 7 });
    expect(chunks).toEqual(['Hello ', 'world']);
    expect(result.text).toBe('Hello world');
  });

  it('streams only the missing suffix when the final result extends streamed text', async () => {
    installClaudeShim(shimDir, [
      '{"type":"assistant","message":{"content":[{"type":"text","text":"Hello"}]}}',
      '{"type":"result","result":"Hello world"}',
    ]);

    const chunks: string[] = [];
    const result = await runClaudePlannerStream({
      prompt: 'do thing',
      projectDir: shimDir,
      sessionId: null,
      onOutput: (text) => chunks.push(text),
    });

    expect(chunks).toEqual(['Hello', ' world']);
    expect(result.text).toBe('Hello world');
  });

  it('records divergent final result text as a typed replacement without replaying it', async () => {
    installClaudeShim(shimDir, [
      '{"type":"assistant","message":{"content":[{"type":"text","text":"draft text"}]}}',
      '{"type":"result","result":"final text"}',
    ]);

    const chunks: string[] = [];
    const events: RunnerCallEvent[] = [];
    const result = await runClaudePlannerStream({
      prompt: 'do thing',
      projectDir: shimDir,
      sessionId: null,
      onOutput: (text) => chunks.push(text),
      onCallEvent: (event) => events.push(event),
    });

    expect(chunks).toEqual(['draft text']);
    expect(result.text).toBe('final text');
    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'call_text_delta',
        channel: 'result',
        text: 'final text',
        semantics: 'final',
      }),
    );
  });

  it('preserves initial sessionId when stream carries none', async () => {
    installClaudeShim(shimDir, [
      '{"type":"assistant","message":{"content":[{"type":"text","text":"ok"}]}}',
      '{"type":"result","result":"ok"}',
    ]);

    const result = await runClaudePlannerStream({
      prompt: 'p',
      projectDir: shimDir,
      sessionId: 'pre-existing-session',
      onOutput: () => {},
    });

    expect(result.sessionId).toBe('pre-existing-session');
  });

  it('emits tool-use events without writing tool summaries to output text', async () => {
    installClaudeShim(shimDir, [
      '{"type":"assistant","message":{"content":[{"type":"tool_use","id":"tool-read","name":"Read","input":{"file_path":"/etc/hosts"}}]}}',
      '{"type":"assistant","message":{"content":[{"type":"tool_use","id":"tool-bash","name":"Bash","input":{"command":"ls -la"}}]}}',
      '{"type":"result","result":""}',
    ]);

    const chunks: string[] = [];
    const events: RunnerCallEvent[] = [];
    await runClaudePlannerStream({
      prompt: 'p',
      projectDir: shimDir,
      sessionId: null,
      onOutput: (text) => chunks.push(text),
      onCallEvent: (event) => events.push(event),
    });

    expect(chunks.join('')).toBe('');
    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'call_tool_use_done',
        toolUse: { id: 'tool-read', name: 'Read', input: { file_path: '/etc/hosts' } },
      }),
    );
    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'call_tool_use_done',
        toolUse: { id: 'tool-bash', name: 'Bash', input: { command: 'ls -la' } },
      }),
    );
  });

  it('preserves stream-json tool id and name on input deltas', async () => {
    installClaudeShim(shimDir, [
      JSON.stringify({
        type: 'stream_event',
        event: {
          type: 'content_block_start',
          index: 1,
          content_block: { type: 'tool_use', id: 'tool-live', name: 'Read', input: {} },
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
      '{"type":"result","result":""}',
    ]);

    const events: RunnerCallEvent[] = [];
    await runClaudePlannerStream({
      prompt: 'p',
      projectDir: shimDir,
      sessionId: null,
      onOutput: () => {},
      onCallEvent: (event) => events.push(event),
    });

    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'call_tool_use_delta',
        toolUseId: 'tool-live',
        name: 'Read',
        inputDelta: '{"file_path":"src/app.ts"}',
      }),
    );
  });

  it('emits questions via onQuestion when the text stream contains question markers', async () => {
    const q = { id: 'q1', type: 'input', text: 'which port?' };
    const marker = `<!-- Q:${JSON.stringify(q)} -->`;
    const assistantEvent = JSON.stringify({
      type: 'assistant',
      message: { content: [{ type: 'text', text: marker }] },
    });
    installClaudeShim(shimDir, [assistantEvent, '{"type":"result","result":""}']);

    const questions: Array<{ id: string }> = [];
    await runClaudePlannerStream({
      prompt: 'p',
      projectDir: shimDir,
      sessionId: null,
      onOutput: () => {},
      onQuestion: (qs) => {
        for (const parsed of qs) questions.push(parsed);
      },
    });

    expect(questions.map((it) => it.id)).toContain('q1');
  });

  it('rejects with CLAUDE_NOT_FOUND message when `claude` is not on PATH', async () => {
    const emptyDir = createTempDir('empty-path');
    const savedPath = process.env['PATH'];
    process.env['PATH'] = emptyDir;
    const events: RunnerCallEvent[] = [];
    try {
      await expect(
        runClaudePlannerStream({
          prompt: 'p',
          projectDir: shimDir,
          sessionId: null,
          onOutput: () => {},
          onCallEvent: (event) => events.push(event),
        }),
      ).rejects.toThrow(/Claude Code CLI not found/);
    } finally {
      if (savedPath === undefined) delete process.env['PATH'];
      else process.env['PATH'] = savedPath;
      cleanupTempDir(emptyDir);
    }
    const errors = runnerCallErrors(events);
    expect(runnerCallTerminals(events)).toHaveLength(1);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({
      status: 'failed',
      error: {
        code: 'command-not-found',
        message: expect.stringContaining('Claude Code CLI not found'),
      },
      partial: false,
    });
    const operations = replayRunnerCallEventsIntoOperations(events);
    expect(operations.active).toBeNull();
    expect(operations.last).toMatchObject({
      callId: errors[0]?.callId,
      status: 'failed',
      reason: expect.stringContaining('Claude Code CLI not found'),
    });
  });

  it('rejects without spawning when the signal is already aborted', async () => {
    installClaudeShim(shimDir, ['{"type":"result","result":"should not run"}']);
    const controller = new AbortController();
    controller.abort(new Error('cancelled'));

    await expect(
      runClaudePlannerStream({
        prompt: 'p',
        projectDir: shimDir,
        sessionId: null,
        onOutput: () => {},
        signal: controller.signal,
      }),
    ).rejects.toThrow('cancelled');
  });

  it('surfaces the in-band is_error reason when claude exits 1 with empty stderr', async () => {
    installClaudeFailingShim(
      shimDir,
      [
        '{"type":"system","session_id":"sess-fail"}',
        '{"type":"result","is_error":true,"result":"Credit balance is too low","session_id":"sess-fail"}',
      ],
      1,
    );

    await expect(
      runClaudePlannerStream({
        prompt: 'p',
        projectDir: shimDir,
        sessionId: null,
        onOutput: () => {},
      }),
    ).rejects.toMatchObject({
      kind: 'process-output',
      message: expect.stringContaining('Credit balance is too low'),
    });
  });

  it('surfaces an is_error result as a failure even when claude exits 0', async () => {
    installClaudeShim(shimDir, [
      '{"type":"system","session_id":"sess-zero"}',
      '{"type":"result","is_error":true,"result":"Overloaded: please retry","session_id":"sess-zero"}',
    ]);

    await expect(
      runClaudePlannerStream({
        prompt: 'p',
        projectDir: shimDir,
        sessionId: null,
        onOutput: () => {},
      }),
    ).rejects.toMatchObject({
      kind: 'process-output',
      message: expect.stringContaining('Overloaded: please retry'),
    });
  });

  it('an idle-killed call finishes failed with code runner_idle_timeout', async () => {
    installClaudeSlowShim(shimDir, ['{"type":"system","session_id":"sess-idle"}']);

    const events: RunnerCallEvent[] = [];
    await expect(
      runClaudePlannerStream({
        prompt: 'p',
        projectDir: shimDir,
        sessionId: null,
        onOutput: () => {},
        onCallEvent: (event) => events.push(event),
        idleWarnMs: 40,
        idleKillMs: 120,
      }),
    ).rejects.toMatchObject({ kind: 'command-idle-timeout' });

    const errors = runnerCallErrors(events);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({
      status: 'failed',
      error: { code: 'runner_idle_timeout' },
    });
  });

  it('emits one call_error for a stream that exits 0 without a result terminal', async () => {
    installClaudeShim(shimDir, [
      '{"type":"assistant","message":{"content":[{"type":"text","text":"partial"}]}}',
    ]);

    const chunks: string[] = [];
    const events: RunnerCallEvent[] = [];
    await expect(
      runClaudePlannerStream({
        prompt: 'p',
        projectDir: shimDir,
        sessionId: null,
        onOutput: (text) => chunks.push(text),
        onCallEvent: (event) => events.push(event),
      }),
    ).rejects.toMatchObject({
      kind: 'process-output',
      message: expect.stringContaining('without a terminal event'),
    });

    expect(chunks.join('')).toContain('partial');
    const errors = runnerCallErrors(events);
    expect(runnerCallTerminals(events)).toHaveLength(1);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({
      status: 'incomplete',
      error: { code: 'missing_terminal_event' },
      partial: true,
    });
    const operations = replayRunnerCallEventsIntoOperations(events);
    expect(operations.active).toBeNull();
    expect(operations.last).toMatchObject({
      callId: errors[0]?.callId,
      status: 'incomplete',
      reason: 'Runner call ended without a terminal event',
      partial: true,
    });
  });

  it('reports an oversized terminal result line as bounded truncation', async () => {
    installClaudeNodeShim(
      shimDir,
      `
const result = "x".repeat(${DEFAULT_PROCESS_LINE_MAX_BYTES + 100});
process.stdout.write(JSON.stringify({ type: "result", result }) + "\\n");
`,
    );

    const events: RunnerCallEvent[] = [];
    await expect(
      runClaudePlannerStream({
        prompt: 'p',
        projectDir: shimDir,
        sessionId: null,
        onOutput: () => {},
        onCallEvent: (event) => events.push(event),
      }),
    ).rejects.toMatchObject({
      kind: 'process-output',
      message: expect.stringContaining('stdout line exceeded'),
    });

    const errors = runnerCallErrors(events);
    expect(runnerCallTerminals(events)).toHaveLength(1);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({
      status: 'truncated',
      error: { code: 'stdout_line_overflow' },
    });
    expect(errors[0]?.error.code).not.toBe('missing_terminal_event');
    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'call_warning',
        warning: expect.objectContaining({
          code: 'stdout_line_overflow',
          message: expect.stringContaining('stdout line exceeded'),
        }),
      }),
    );
  });

  it('caps many small assistant chunks before accumulating unbounded output', async () => {
    installClaudeNodeShim(
      shimDir,
      `
for (let i = 0; i < ${RUNNER_CALL_OUTPUT_MAX_EVENTS + 1}; i += 1) {
  process.stdout.write(JSON.stringify({
    type: "assistant",
    message: { content: [{ type: "text", text: "x" }] }
  }) + "\\n");
}
process.stdout.write(JSON.stringify({
  type: "result",
  result: "x".repeat(${RUNNER_CALL_OUTPUT_MAX_EVENTS + 1})
}) + "\\n");
`,
    );

    const chunks: string[] = [];
    const events: RunnerCallEvent[] = [];
    await expect(
      runClaudePlannerStream({
        prompt: 'p',
        projectDir: shimDir,
        sessionId: null,
        onOutput: (text) => chunks.push(text),
        onCallEvent: (event) => events.push(event),
      }),
    ).rejects.toMatchObject({
      kind: 'process-output',
      message: expect.stringContaining('runner output text exceeded'),
    });

    const textEvents = events.filter((event) => event.type === 'call_text_delta');
    const errors = runnerCallErrors(events);
    expect(chunks.join('')).toBe('x'.repeat(RUNNER_CALL_OUTPUT_MAX_EVENTS));
    expect(textEvents).toHaveLength(RUNNER_CALL_OUTPUT_MAX_EVENTS);
    expect(runnerCallTerminals(events)).toHaveLength(1);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({
      status: 'truncated',
      error: { code: 'runner_output_text_limit' },
    });
  });

  it('emits session id and partial output before an interrupted stream rejects', async () => {
    installClaudeSlowShim(shimDir, [
      '{"type":"system","session_id":"sess-interrupt"}',
      '{"type":"assistant","message":{"content":[{"type":"text","text":"partial"}]}}',
    ]);
    const controller = new AbortController();
    const chunks: string[] = [];
    const sessions: string[] = [];
    const events: RunnerCallEvent[] = [];

    await expect(
      runClaudePlannerStream({
        prompt: 'p',
        projectDir: shimDir,
        sessionId: null,
        onOutput: (text) => {
          chunks.push(text);
          if (text.includes('partial')) controller.abort(new Error('cancelled'));
        },
        onSessionId: (id) => sessions.push(id),
        onCallEvent: (event) => events.push(event),
        signal: controller.signal,
      }),
    ).rejects.toThrow('cancelled');

    expect(sessions).toContain('sess-interrupt');
    expect(chunks.join('')).toContain('partial');
    const errors = runnerCallErrors(events);
    expect(runnerCallTerminals(events)).toHaveLength(1);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({
      status: 'aborted',
      error: { code: 'runner_interrupted', message: 'cancelled' },
      nativeSessionId: 'sess-interrupt',
      partial: true,
    });
  });

  it('preserves timeout abort reason separately from user abort', async () => {
    installClaudeSlowShim(shimDir, [
      '{"type":"system","session_id":"sess-timeout"}',
      '{"type":"assistant","message":{"content":[{"type":"text","text":"partial"}]}}',
    ]);

    await expect(
      runClaudePlannerStream({
        prompt: 'p',
        projectDir: shimDir,
        sessionId: null,
        onOutput: () => {},
        signal: AbortSignal.timeout(20),
      }),
    ).rejects.toMatchObject({ name: 'TimeoutError' });
  });

  it('embeds image attachments as prompt references in stdin, never as --image argv', async () => {
    const { argvFile, stdinFile } = installClaudeRecordingShim(shimDir);

    await runClaudePlannerStream({
      prompt: 'describe the screenshot',
      projectDir: shimDir,
      sessionId: null,
      onOutput: () => {},
      images: [makeClaudeTestImage('/tmp/a.png'), makeClaudeTestImage('/tmp/b.png')],
    });

    const argv = readFileSync(argvFile, 'utf8');
    const stdin = readFileSync(stdinFile, 'utf8');

    expect(argv).not.toContain('--image');
    expect(argv).not.toContain('/tmp/a.png');

    expect(stdin).toContain('[image attachment: /tmp/a.png]');
    expect(stdin).toContain('[image attachment: /tmp/b.png]');
    expect(stdin).toContain('describe the screenshot');
  });

  it('passes effort as an --effort argv flag, never as an /effort stdin prefix', async () => {
    const { argvFile, stdinFile } = installClaudeRecordingShim(shimDir);

    await runClaudePlannerStream({
      prompt: 'go',
      projectDir: shimDir,
      sessionId: null,
      onOutput: () => {},
      effort: 'high',
      images: [makeClaudeTestImage('/tmp/a.png')],
    });

    const argv = readFileSync(argvFile, 'utf8').split('\n');
    const stdin = readFileSync(stdinFile, 'utf8');

    const effortIdx = argv.indexOf('--effort');
    expect(effortIdx).toBeGreaterThanOrEqual(0);
    expect(argv[effortIdx + 1]).toBe('high');

    expect(stdin).not.toContain('/effort');
    expect(stdin.startsWith('[image attachment: /tmp/a.png]')).toBe(true);
    expect(stdin).toContain('go');
  });

  it('omits the --effort flag entirely when no effort is configured', async () => {
    const { argvFile } = installClaudeRecordingShim(shimDir);

    await runClaudePlannerStream({
      prompt: 'go',
      projectDir: shimDir,
      sessionId: null,
      onOutput: () => {},
    });

    const argv = readFileSync(argvFile, 'utf8');
    expect(argv).not.toContain('--effort');
  });
});
