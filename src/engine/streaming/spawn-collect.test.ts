import { describe, it, expect } from 'vitest';
import { DEFAULT_PROCESS_LINE_MAX_BYTES } from '../../lib/process/spawn.js';
import { RUNNER_CALL_OUTPUT_MAX_EVENTS } from '../calls/output-limit.js';
import { spawnAndCollect } from './spawn-collect.js';
import { parseJsonlLine } from './parse-jsonl.js';
import type { RunnerCallEvent } from '../calls/types.js';
import {
  replayRunnerCallEventsIntoOperations,
  runnerCallErrors,
  runnerCallTerminals,
} from '#testing/helpers/runner-call-events.js';

describe('spawnAndCollect', () => {
  it('collects parsed text from lines', async () => {
    const outputChunks: string[] = [];
    const result = await spawnAndCollect({
      command: 'echo',
      args: ['collected'],
      cwd: '.',
      notFoundMessage: 'echo not found',
      parseLine: (line) => (line.trim() ? { text: line + '\n' } : {}),
      onText: (text) => outputChunks.push(text),
    });

    expect(result.text).toContain('collected');
    expect(outputChunks.join('')).toContain('collected');
    expect(result.usage).toBeNull();
  });

  it('accumulates usage from parsed lines', async () => {
    const result = await spawnAndCollect({
      command: 'node',
      args: ['-e', 'console.log("line1"); console.log("line2")'],
      cwd: '.',
      notFoundMessage: 'node not found',
      parseLine: (line) => {
        if (line.includes('line1'))
          return { text: 'a', usage: { inputTokens: 10, outputTokens: 5 } };
        if (line.includes('line2'))
          return { text: 'b', usage: { inputTokens: 20, outputTokens: 10 } };
        return {};
      },
      onText: () => {},
    });

    expect(result.text).toBe('ab');
    expect(result.usage).toEqual({ inputTokens: 30, outputTokens: 15 });
  });

  it('emits one failed terminal before rethrowing command-not-found', async () => {
    const events: RunnerCallEvent[] = [];

    await expect(
      spawnAndCollect({
        command: 'nonexistent-command-xyz',
        args: [],
        cwd: process.cwd(),
        notFoundMessage: 'missing command',
        onCallEvent: (event) => events.push(event),
      }),
    ).rejects.toThrow('missing command');

    const errors = runnerCallErrors(events);
    expect(runnerCallTerminals(events)).toHaveLength(1);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({
      status: 'failed',
      error: { code: 'command-not-found', message: 'missing command' },
      partial: false,
    });
    const operations = replayRunnerCallEventsIntoOperations(events);
    expect(operations.active).toBeNull();
    expect(operations.last).toMatchObject({
      callId: errors[0]?.callId,
      status: 'failed',
      reason: 'missing command',
    });
  });

  it('emits one failed terminal before rethrowing a non-abort process failure', async () => {
    const events: RunnerCallEvent[] = [];

    await expect(
      spawnAndCollect({
        command: 'node',
        args: ['-e', 'console.log("partial"); process.exit(2)'],
        cwd: process.cwd(),
        parseLine: (line) => (line.trim() ? { text: line } : {}),
        onCallEvent: (event) => events.push(event),
      }),
    ).rejects.toMatchObject({ kind: 'process-output' });

    const errors = runnerCallErrors(events);
    expect(runnerCallTerminals(events)).toHaveLength(1);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({
      status: 'failed',
      error: { code: 'process-output', message: expect.stringContaining('exited with code 2') },
      partial: true,
    });
    const operations = replayRunnerCallEventsIntoOperations(events);
    expect(operations.active).toBeNull();
    expect(operations.last).toMatchObject({
      callId: errors[0]?.callId,
      status: 'failed',
      reason: expect.stringContaining('exited with code 2'),
      partial: true,
    });
  });

  it('buffers stderr chunks without promoting them to result warnings by default', async () => {
    const stderrChunks: string[] = [];
    const result = await spawnAndCollect({
      command: 'node',
      args: [
        '-e',
        'process.stderr.write("first "); process.stderr.write("line\\nsecond"); process.stderr.write(" line\\n")',
      ],
      cwd: process.cwd(),
      onStderr: (chunk) => stderrChunks.push(chunk),
    });

    expect(stderrChunks.join('')).toBe('first line\nsecond line\n');
    expect(result.warnings).toEqual([]);
  });

  it('flushes warning-like trailing stderr as a bounded status warning', async () => {
    const result = await spawnAndCollect({
      command: 'node',
      args: ['-e', 'process.stderr.write("trailing warning")'],
      cwd: process.cwd(),
    });

    expect(result.warnings).toEqual([
      expect.objectContaining({
        code: 'stderr_diagnostic',
        source: 'stderr',
        surface: 'status',
        channel: 'stderr',
        message: 'trailing warning',
      }),
    ]);
  });

  it('bounds oversized stderr lines and emits an overflow warning', async () => {
    const result = await spawnAndCollect({
      command: 'node',
      args: ['-e', 'process.stderr.write("x".repeat(9000))'],
      cwd: process.cwd(),
    });

    expect(result.warnings).toEqual([
      expect.objectContaining({
        code: 'stderr_line_overflow',
        severity: 'warning',
        source: 'provider',
        surface: 'activity',
        message: 'stderr line exceeded 8192 bytes and was skipped',
      }),
    ]);
  });

  it('reports an oversized structured terminal result as a bounded truncation', async () => {
    const result = await spawnAndCollect({
      command: 'node',
      args: [
        '-e',
        `process.stdout.write(JSON.stringify({type:"result",result:"x".repeat(${
          DEFAULT_PROCESS_LINE_MAX_BYTES + 100
        })})+"\\n")`,
      ],
      cwd: process.cwd(),
      format: 'stream-json',
    });

    expect(result).toMatchObject({
      status: 'truncated',
      text: '',
      error: { code: 'stdout_line_overflow' },
    });
    expect(result.error?.code).not.toBe('missing_terminal_event');
    expect(result.warnings).toEqual([
      expect.objectContaining({
        code: 'stdout_line_overflow',
        message: expect.stringContaining('stdout line exceeded'),
      }),
    ]);
  });

  it('caps aggregate parsed stdout from many small lines', async () => {
    const events: RunnerCallEvent[] = [];
    const result = await spawnAndCollect({
      command: 'node',
      args: [
        '-e',
        `for (let i = 0; i < ${RUNNER_CALL_OUTPUT_MAX_EVENTS + 1}; i += 1) console.log("x")`,
      ],
      cwd: process.cwd(),
      onCallEvent: (event) => events.push(event),
    });

    const textEvents = events.filter((event) => event.type === 'call_text_delta');
    expect(result).toMatchObject({
      status: 'truncated',
      error: { code: 'runner_output_text_limit' },
    });
    expect(result.text).toBe('x\n'.repeat(RUNNER_CALL_OUTPUT_MAX_EVENTS));
    expect(textEvents).toHaveLength(RUNNER_CALL_OUTPUT_MAX_EVENTS);
  });
});

describe('CLI implementer JSONL parsing', () => {
  it('parses codex-style JSONL into human-readable text', async () => {
    const jsonlOutput = [
      JSON.stringify({ type: 'thread.started', thread_id: 'sess_123' }),
      JSON.stringify({
        type: 'item.completed',
        item: {
          type: 'agent_message',
          content: [{ type: 'output_text', text: 'Created the file successfully.' }],
        },
      }),
      JSON.stringify({
        type: 'turn.completed',
        usage: { input_tokens: 100, output_tokens: 50 },
      }),
    ].join('\n');

    const script = `process.stdout.write(${JSON.stringify(jsonlOutput + '\n')})`;

    const collected: string[] = [];
    const result = await spawnAndCollect({
      command: 'node',
      args: ['-e', script],
      cwd: process.cwd(),
      parseLine: parseJsonlLine,
      onText: (text) => collected.push(text),
    });

    expect(result.text).toContain('Created the file successfully.');
    expect(result.text).not.toContain('"type":"item.completed"');
    expect(result.text).not.toContain('"type":"thread.started"');
    expect(collected.join('')).toContain('Created the file successfully.');
    expect(result.sessionId).toBe('sess_123');
  });

  it('collects malformed JSONL lines as per-call warnings', async () => {
    const result = await spawnAndCollect({
      command: 'node',
      args: ['-e', 'process.stdout.write("not json {{\\n")'],
      cwd: process.cwd(),
      parseLine: parseJsonlLine,
    });

    expect(result.warnings).toEqual([
      expect.objectContaining({
        code: 'malformed_jsonl',
        severity: 'warning',
        source: 'jsonl',
        surface: 'activity',
        parser: 'jsonl',
        upstreamType: 'malformed_json',
        channel: 'stdout',
        message: expect.stringContaining('Malformed jsonl record'),
      }),
    ]);
  });

  it('falls back to text parsing for plain-text CLI output', async () => {
    const plainOutput = 'Applied changes to src/main.ts\nDone.\n';
    const script = `process.stdout.write(${JSON.stringify(plainOutput)})`;

    const collected: string[] = [];
    const result = await spawnAndCollect({
      command: 'node',
      args: ['-e', script],
      cwd: process.cwd(),
      onText: (text) => collected.push(text),
    });

    expect(result.text).toContain('Applied changes to src/main.ts');
    expect(result.text).toContain('Done.');
  });
});
