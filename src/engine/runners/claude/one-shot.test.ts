import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { runClaudeOneShot } from './invoke.js';
import { DEFAULT_PROCESS_LINE_MAX_BYTES } from '../../../lib/process/spawn/lifecycle.js';
import { createTempDir, cleanupTempDir } from '#testing/helpers/temp-dir.js';
import type { RunnerCallEvent } from '../../calls/types.js';
import {
  replayRunnerCallEventsIntoOperations,
  runnerCallErrors,
  runnerCallTerminals,
} from '#testing/helpers/runner-call-events.js';
import { prependPath } from '#testing/helpers/command-shim.js';
import {
  installClaudeNodeShim,
  installClaudeRecordingShim,
  installClaudeShim,
} from '#testing/helpers/claude-cli-shim.js';

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

describe('runClaudeOneShot', () => {
  it('returns text and usage from the result event', async () => {
    installClaudeShim(shimDir, [
      '{"type":"assistant","message":{"content":[{"type":"text","text":"reply"}]}}',
      '{"type":"result","result":"reply","usage":{"input_tokens":3,"output_tokens":1}}',
    ]);

    const result = await runClaudeOneShot({
      prompt: 'hi',
      projectDir: shimDir,
      onOutput: () => {},
    });

    expect(result.text).toBe('reply');
    expect(result.usage).toEqual({ inputTokens: 3, outputTokens: 1 });
  });

  it('streams text chunks to onOutput in order they arrive', async () => {
    installClaudeShim(shimDir, [
      '{"type":"assistant","message":{"content":[{"type":"text","text":"one "}]}}',
      '{"type":"assistant","message":{"content":[{"type":"text","text":"two "}]}}',
      '{"type":"assistant","message":{"content":[{"type":"text","text":"three"}]}}',
      '{"type":"result","result":"one two three"}',
    ]);

    const chunks: string[] = [];
    await runClaudeOneShot({
      prompt: 'p',
      projectDir: shimDir,
      onOutput: (text) => chunks.push(text),
    });

    const streamed = chunks.join('');
    expect(streamed).toContain('one ');
    expect(streamed).toContain('two ');
    expect(streamed).toContain('three');
    expect(streamed.indexOf('one')).toBeLessThan(streamed.indexOf('two'));
    expect(streamed.indexOf('two')).toBeLessThan(streamed.indexOf('three'));
  });

  it('rejects with CLAUDE_NOT_FOUND when claude binary is missing', async () => {
    const emptyDir = createTempDir('empty-path-2');
    const savedPath = process.env['PATH'];
    process.env['PATH'] = emptyDir;
    const events: RunnerCallEvent[] = [];
    try {
      await expect(
        runClaudeOneShot({
          prompt: 'p',
          projectDir: shimDir,
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
      runClaudeOneShot({
        prompt: 'p',
        projectDir: shimDir,
        onOutput: () => {},
        signal: controller.signal,
      }),
    ).rejects.toThrow('cancelled');
  });

  it('passes effort as an --effort argv flag and leaves stdin as the raw prompt', async () => {
    const { argvFile, stdinFile } = installClaudeRecordingShim(shimDir);

    await runClaudeOneShot({
      prompt: 'escalate me',
      projectDir: shimDir,
      onOutput: () => {},
      effort: 'xhigh',
    });

    const argv = readFileSync(argvFile, 'utf8').split('\n');
    const stdin = readFileSync(stdinFile, 'utf8');

    const effortIdx = argv.indexOf('--effort');
    expect(effortIdx).toBeGreaterThanOrEqual(0);
    expect(argv[effortIdx + 1]).toBe('xhigh');
    expect(stdin).not.toContain('/effort');
    expect(stdin.startsWith('escalate me')).toBe(true);
  });

  it('surfaces an is_error result as a failure even when claude exits 0', async () => {
    installClaudeShim(shimDir, [
      '{"type":"result","is_error":true,"result":"Credit balance is too low"}',
    ]);

    await expect(
      runClaudeOneShot({
        prompt: 'p',
        projectDir: shimDir,
        onOutput: () => {},
      }),
    ).rejects.toMatchObject({
      kind: 'process-output',
      message: expect.stringContaining('Credit balance is too low'),
    });
  });

  it('emits one call_error when the stream contains no result event', async () => {
    installClaudeShim(shimDir, [
      '{"type":"assistant","message":{"content":[{"type":"text","text":"partial"}]}}',
    ]);

    const chunks: string[] = [];
    const events: RunnerCallEvent[] = [];
    await expect(
      runClaudeOneShot({
        prompt: 'p',
        projectDir: shimDir,
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
      runClaudeOneShot({
        prompt: 'p',
        projectDir: shimDir,
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
  });
});
