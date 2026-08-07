import { describe, it, expect, vi } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DEFAULT_PROCESS_LINE_MAX_BYTES } from '../../lib/process/spawn/lifecycle.js';
import { projectRunnerCallEvents } from '../calls/event-projection.js';
import { runnerCallEventToSessionLogEntry } from '../calls/session-log.js';
import { RUNNER_CALL_OUTPUT_MAX_EVENTS } from '../calls/output-limit.js';
import { protectEngineEventForConsumer } from '../events/protection/protect.js';
import { spawnAndCollect, spawnCollectError } from './spawn-collect.js';
import { parseJsonlLine } from './parse-jsonl.js';
import {
  CUSTOM_RUNNER_TOOL_INPUT_MAX_ACTIVE,
  createCustomRunnerRedactor,
} from '../runners/redaction.js';
import { createRunnerSandboxEnv } from '../runners/sandbox-env.js';
import { withTempDir } from '#testing/helpers/temp-dir.js';
import type { RunnerCallEvent } from '../calls/types.js';
import {
  replayRunnerCallEventsIntoOperations,
  runnerCallErrors,
  runnerCallTerminals,
} from '#testing/helpers/runner-call-events.js';

describe('spawnAndCollect', () => {
  it('redacts selected environment credentials from result and live callbacks', async () => {
    const credential = 'opaque-spawn-credential-canary-7d93c612';
    const events: RunnerCallEvent[] = [];
    const output: string[] = [];
    const stderr: string[] = [];
    const result = await spawnAndCollect({
      command: 'node',
      args: [
        '-e',
        `process.stdout.write(JSON.stringify({type:'result',result:${JSON.stringify(credential)}})+'\\n');process.stderr.write(${JSON.stringify(`debug ${credential}`)})`,
      ],
      cwd: '.',
      env: { ...process.env, OPENAI_API_KEY: credential },
      format: 'stream-json',
      onText: (text) => output.push(text),
      onStderr: (text) => stderr.push(text),
      onCallEvent: (event) => events.push(event),
    });

    const persisted = JSON.stringify({ result, events, output, stderr });
    expect(persisted).not.toContain(credential);
    expect(persisted).toContain('***REDACTED***');
    expect(result.text).toContain('***REDACTED***');

    const failureEvents: RunnerCallEvent[] = [];
    await expect(
      spawnAndCollect({
        command: 'node',
        args: ['-e', `process.stderr.write(${JSON.stringify(credential)});process.exit(2)`],
        cwd: '.',
        env: { ...process.env, OPENAI_API_KEY: credential },
        onCallEvent: (event) => failureEvents.push(event),
      }),
    ).rejects.toThrow('***REDACTED***');
    expect(JSON.stringify(failureEvents)).not.toContain(credential);
  });

  it('rejects invalid hard deadlines as typed errors without leaking declared values', async () => {
    const declaredValue = 'invalid-hard-deadline-value-canary-7c3d';
    let callbackCalled = false;
    let failure: unknown;

    try {
      await spawnAndCollect({
        command: process.execPath,
        args: ['-e', 'process.stdout.write(process.env.CUSTOM_PUBLIC_VALUE)'],
        cwd: process.cwd(),
        env: { CUSTOM_PUBLIC_VALUE: declaredValue },
        credentialValues: [declaredValue],
        redact: createCustomRunnerRedactor([declaredValue]),
        timeoutMs: -1,
        onText: () => {
          callbackCalled = true;
        },
      });
    } catch (error) {
      failure = error;
    }

    expect(spawnCollectError.isInvalidHardDeadline(failure)).toBe(true);
    expect(failure).toMatchObject({
      kind: 'runner-invalid-timeout',
      message: 'Runner hard deadline must be a positive finite number of milliseconds.',
      data: { timeoutMs: -1 },
    });
    expect(callbackCalled).toBe(false);
    expect(
      JSON.stringify(
        failure instanceof Error
          ? { message: failure.message, enumerable: Object.fromEntries(Object.entries(failure)) }
          : failure,
      ),
    ).not.toContain(declaredValue);
  });

  it('keeps a declared value split between structured assistant and final output off every observable surface', async () => {
    const declaredValue = 'structured-assistant-final-value-canary-a91f';
    const splitAt = 'structured-assistant-final-'.length;
    const assistantText = `assistant: ${declaredValue.slice(0, splitAt)}`;
    const finalText = `assistant: ${declaredValue}`;
    const callbacks: string[] = [];
    const events: RunnerCallEvent[] = [];
    const result = await spawnAndCollect({
      command: process.execPath,
      args: [
        '-e',
        [
          "const emit = (event) => process.stdout.write(JSON.stringify(event) + '\\n');",
          `emit(${JSON.stringify({
            type: 'assistant',
            message: { content: [{ type: 'text', text: assistantText }] },
          })});`,
          `emit(${JSON.stringify({ type: 'result', result: finalText, is_error: true })});`,
        ].join(''),
      ],
      cwd: process.cwd(),
      format: 'stream-json',
      credentialValues: [declaredValue],
      redact: createCustomRunnerRedactor([declaredValue]),
      onText: (text) => callbacks.push(text),
      onCallEvent: (event) => events.push(event),
    });

    const observed = JSON.stringify({
      callbacks,
      result,
      events,
      errors: runnerCallErrors(events),
    });

    expect(result).toMatchObject({
      status: 'failed',
      text: 'assistant: ***REDACTED***',
      error: { code: 'runner_result_error', message: 'assistant: ***REDACTED***' },
    });
    expect(callbacks.join('')).toBe('assistant: ***REDACTED***');
    expect(observed).not.toContain(declaredValue.slice(0, splitAt));
    expect(observed).not.toContain(declaredValue.slice(splitAt));
  });

  it('redacts fragmented stream-json tool input before callback, event, protected, and session-log surfaces', async () => {
    const canary = 'tool-input-stream-fragment-canary-6f2a';
    const splitAt = 'tool-input-stream-'.length;
    const callbackEvents: RunnerCallEvent[] = [];
    const records = [
      {
        type: 'stream_event',
        event: {
          type: 'content_block_start',
          content_block: { type: 'tool_use', id: 'tool-real', name: 'Write', input: {} },
        },
      },
      {
        type: 'stream_event',
        event: {
          type: 'content_block_delta',
          index: 1,
          delta: {
            type: 'input_json_delta',
            partial_json: `{"value":"${canary.slice(0, splitAt)}`,
          },
        },
      },
      {
        type: 'stream_event',
        event: {
          type: 'content_block_delta',
          index: 2,
          delta: { type: 'input_json_delta', partial_json: '{"path":"src/app.ts"}' },
        },
      },
      {
        type: 'stream_event',
        event: {
          type: 'content_block_delta',
          index: 1,
          delta: {
            type: 'input_json_delta',
            partial_json: `${canary.slice(splitAt)}"}`,
          },
        },
      },
      { type: 'result', result: 'runner failed', is_error: true },
    ];
    const result = await spawnAndCollect({
      command: process.execPath,
      args: [
        '-e',
        `for (const record of ${JSON.stringify(records)}) process.stdout.write(JSON.stringify(record) + '\\n');`,
      ],
      cwd: process.cwd(),
      format: 'stream-json',
      credentialValues: [canary],
      redact: createCustomRunnerRedactor([canary]),
      onCallEvent: (event) => callbackEvents.push(event),
    });

    const projected = callbackEvents.flatMap((event, index) =>
      projectRunnerCallEvents(event, { phase: 'planning', sequence: index + 1 }),
    );
    const protectedEvents = projected.map((event) =>
      protectEngineEventForConsumer(event, { context: 'ipc', persistTranscript: true }),
    );
    const sessionEntries = callbackEvents.map((event, index) =>
      runnerCallEventToSessionLogEntry(event, { phase: 'planning', sequence: index + 1 }),
    );
    const observed = JSON.stringify({
      callbackEvents,
      events: callbackEvents,
      protectedEvents,
      result,
      sessionEntries,
    });
    const toolDeltas = callbackEvents.filter((event) => event.type === 'call_tool_use_delta');

    expect(result.status).toBe('failed');
    expect(
      toolDeltas.map(({ toolUseId, name, inputDelta }) => ({ toolUseId, name, inputDelta })),
    ).toEqual([
      { toolUseId: 'tool-real', name: 'Write', inputDelta: '{}' },
      { toolUseId: 'tool-real', name: 'Write', inputDelta: '{"value":"' },
      { toolUseId: 'tool-real', name: 'Write', inputDelta: '{"path":"src/app.ts"}' },
      { toolUseId: 'tool-real', name: 'Write', inputDelta: '***REDACTED***"}' },
    ]);
    expect(observed).not.toContain(canary);
    expect(observed).not.toContain(canary.slice(0, splitAt));
    expect(observed).not.toContain(canary.slice(splitAt));
    expect(observed).toContain('***REDACTED***');
  });

  it('keeps a tool-input redaction boundary across an unrelated stream-json text delta', async () => {
    const canary = 'tool-input-interleaved-text-canary-45af';
    const splitAt = 'tool-input-interleaved-'.length;
    const callbacks: string[] = [];
    const callbackEvents: RunnerCallEvent[] = [];
    const records = [
      {
        type: 'stream_event',
        event: {
          type: 'content_block_start',
          content_block: { type: 'tool_use', id: 'tool-real', name: 'Write', input: {} },
        },
      },
      {
        type: 'stream_event',
        event: {
          type: 'content_block_delta',
          index: 1,
          delta: {
            type: 'input_json_delta',
            partial_json: `{"value":"${canary.slice(0, splitAt)}`,
          },
        },
      },
      {
        type: 'stream_event',
        event: {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'text_delta', text: 'unrelated assistant text' },
        },
      },
      {
        type: 'stream_event',
        event: {
          type: 'content_block_delta',
          index: 1,
          delta: {
            type: 'input_json_delta',
            partial_json: `${canary.slice(splitAt)}"}`,
          },
        },
      },
      { type: 'result', result: 'done' },
    ];
    const result = await spawnAndCollect({
      command: process.execPath,
      args: [
        '-e',
        `for (const record of ${JSON.stringify(records)}) process.stdout.write(JSON.stringify(record) + '\\n');`,
      ],
      cwd: process.cwd(),
      format: 'stream-json',
      credentialValues: [canary],
      redact: createCustomRunnerRedactor([canary]),
      onText: (text) => callbacks.push(text),
      onCallEvent: (event) => callbackEvents.push(event),
    });

    const projected = callbackEvents.flatMap((event, index) =>
      projectRunnerCallEvents(event, { phase: 'planning', sequence: index + 1 }),
    );
    const protectedEvents = projected.map((event) =>
      protectEngineEventForConsumer(event, { context: 'ipc', persistTranscript: true }),
    );
    const sessionEntries = callbackEvents.map((event, index) =>
      runnerCallEventToSessionLogEntry(event, { phase: 'planning', sequence: index + 1 }),
    );
    const toolDeltas = callbackEvents.filter((event) => event.type === 'call_tool_use_delta');
    const observed = JSON.stringify({
      callbacks,
      callbackEvents,
      protectedEvents,
      result,
      sessionEntries,
    });

    expect(result).toMatchObject({ status: 'completed', text: 'done' });
    expect(
      toolDeltas.map(({ toolUseId, name, inputDelta }) => ({ toolUseId, name, inputDelta })),
    ).toEqual([
      { toolUseId: 'tool-real', name: 'Write', inputDelta: '{}' },
      { toolUseId: 'tool-real', name: 'Write', inputDelta: '{"value":"' },
      { toolUseId: 'tool-real', name: 'Write', inputDelta: '***REDACTED***"}' },
    ]);
    expect(callbacks.join('')).toBe('unrelated assistant tex***REDACTED***');
    expect(observed).not.toContain(canary);
    expect(observed).not.toContain(canary.slice(0, splitAt));
    expect(observed).not.toContain(canary.slice(splitAt));
  });

  it('fails closed and reaps the process tree when concurrent structured tool-input state exceeds its bound', async () => {
    const canary = 'tool-input-capacity-stream-canary-62bc';
    const splitAt = 'tool-input-capacity-'.length;
    const prefix = canary.slice(0, splitAt);
    const suffix = canary.slice(splitAt);
    const callbacks: string[] = [];
    const callbackEvents: RunnerCallEvent[] = [];
    let leaderPid = 0;
    let descendantPid = 0;
    let absentAtRejection: { leader: boolean; descendant: boolean } | undefined;
    let result: Awaited<ReturnType<typeof spawnAndCollect>> | undefined;
    let failure: unknown;
    const processIsAbsent = (pid: number) => {
      try {
        process.kill(pid, 0);
        return false;
      } catch {
        return true;
      }
    };
    const program = [
      "const { spawn } = require('node:child_process');",
      `const child = spawn(${JSON.stringify(process.execPath)}, ['-e', 'setInterval(() => {}, 60_000)'], { stdio: 'ignore' });`,
      "const emit = (record) => process.stdout.write(JSON.stringify(record) + '\\n');",
      "emit({ type: 'assistant', message: { content: [{ type: 'text', text: 'pids:' + process.pid + ':' + child.pid }] } });",
      `const prefix = ${JSON.stringify(`{"value":"${prefix}`)};`,
      `const suffix = ${JSON.stringify(`${suffix}"}`)};`,
      `for (let index = 0; index < ${CUSTOM_RUNNER_TOOL_INPUT_MAX_ACTIVE}; index += 1) {`,
      "  emit({ type: 'stream_event', event: { type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: prefix } } });",
      '}',
      `emit({ type: 'stream_event', event: { type: 'content_block_delta', index: ${CUSTOM_RUNNER_TOOL_INPUT_MAX_ACTIVE}, delta: { type: 'input_json_delta', partial_json: prefix } } });`,
      "emit({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: suffix } } });",
      'setInterval(() => {}, 60_000);',
    ].join('');

    try {
      result = await spawnAndCollect({
        command: process.execPath,
        args: ['-e', program],
        cwd: process.cwd(),
        format: 'stream-json',
        credentialValues: [canary],
        redact: createCustomRunnerRedactor([canary]),
        onText: (text) => {
          callbacks.push(text);
          const match = /^pids:(\d+):(\d+)$/.exec(text);
          if (match?.[1] === undefined || match[2] === undefined) return;
          leaderPid = Number.parseInt(match[1], 10);
          descendantPid = Number.parseInt(match[2], 10);
        },
        onCallEvent: (event) => callbackEvents.push(event),
      });
    } catch (error) {
      failure = error;
      absentAtRejection = {
        leader: processIsAbsent(leaderPid),
        descendant: processIsAbsent(descendantPid),
      };
    }

    try {
      const projected = callbackEvents.flatMap((event, index) =>
        projectRunnerCallEvents(event, { phase: 'planning', sequence: index + 1 }),
      );
      const protectedEvents = projected.map((event) =>
        protectEngineEventForConsumer(event, { context: 'ipc', persistTranscript: true }),
      );
      const sessionEntries = callbackEvents.map((event, index) =>
        runnerCallEventToSessionLogEntry(event, { phase: 'planning', sequence: index + 1 }),
      );
      const observedFailure =
        failure instanceof Error
          ? {
              kind: (failure as Error & { kind?: unknown }).kind,
              message: failure.message,
              data: (failure as Error & { data?: unknown }).data,
            }
          : failure;
      const observed = JSON.stringify({
        callbacks,
        callbackEvents,
        protectedEvents,
        sessionEntries,
        result,
        failure: observedFailure,
      });

      expect(result).toBeUndefined();
      expect(failure).toMatchObject({ kind: 'custom-runner-tool-input-state-limit' });
      expect(runnerCallErrors(callbackEvents)).toEqual([
        expect.objectContaining({
          status: 'failed',
          partial: false,
          error: expect.objectContaining({ code: 'custom-runner-tool-input-state-limit' }),
        }),
      ]);
      expect(callbackEvents.some((event) => event.type === 'call_completed')).toBe(false);
      expect(leaderPid).toBeGreaterThan(1);
      expect(descendantPid).toBeGreaterThan(1);
      expect(absentAtRejection).toEqual({ leader: true, descendant: true });
      expect(observed).not.toContain(canary);
      expect(observed).not.toContain(prefix);
      expect(observed).not.toContain(suffix);
    } finally {
      for (const pid of [leaderPid, descendantPid]) {
        if (pid <= 1 || processIsAbsent(pid)) continue;
        process.kill(pid, 'SIGKILL');
      }
    }
  });

  it('redacts declared values from enumerable process-failure data before any controlled surface observes it', async () => {
    const declaredValue = 'enumerable-error-value-canary-83de';
    const callbacks: string[] = [];
    const events: RunnerCallEvent[] = [];
    let failure: unknown;

    try {
      await spawnAndCollect({
        command: process.execPath,
        args: [
          '-e',
          'const value = process.env.CUSTOM_PUBLIC_VALUE;process.stdout.write("stdout-" + value);process.stderr.write("stderr-" + value);process.exit(2);',
        ],
        cwd: process.cwd(),
        env: { CUSTOM_PUBLIC_VALUE: declaredValue },
        credentialValues: [declaredValue],
        redact: createCustomRunnerRedactor([declaredValue]),
        onText: (value) => callbacks.push(value),
        onStderr: (value) => callbacks.push(value),
        onCallEvent: (event) => events.push(event),
      });
    } catch (error) {
      failure = error;
    }

    const observedFailure =
      failure instanceof Error || failure instanceof DOMException
        ? {
            name: failure.name,
            message: failure.message,
            enumerable: Object.fromEntries(Object.entries(failure)),
          }
        : failure;
    const observed = JSON.stringify({
      callbacks: callbacks.join(''),
      events,
      failure: observedFailure,
    });

    expect(failure).toMatchObject({ kind: 'process-output' });
    expect(observed).not.toContain(declaredValue);
  });

  it('redacts credentials read from a bridged state file in the collector path', async () => {
    await withTempDir('splitbrief-collector-state-host', async (hostHome) => {
      await withTempDir('splitbrief-collector-state-project', async (projectDir) => {
        const credential = 'bridged-collector-state-canary-90e2';
        mkdirSync(join(hostHome, '.codex'), { recursive: true });
        writeFileSync(join(hostHome, '.codex', 'auth.json'), JSON.stringify({ token: credential }));
        const previousHome = process.env.HOME;
        process.env.HOME = hostHome;
        try {
          const env = await createRunnerSandboxEnv(
            projectDir,
            { kind: 'cli', tool: 'codex', authChannel: 'session' },
            'implementer',
          );
          const events: RunnerCallEvent[] = [];
          const result = await spawnAndCollect({
            command: 'node',
            args: [
              '-e',
              "const fs=require('node:fs');const path=require('node:path');const token=JSON.parse(fs.readFileSync(path.join(process.env.HOME,'.codex','auth.json'),'utf8')).token;process.stdout.write(token+'\\n');process.stderr.write('state='+token)",
            ],
            cwd: projectDir,
            env,
            onCallEvent: (event) => events.push(event),
          });
          const persisted = JSON.stringify({ result, events });
          expect(persisted).not.toContain(credential);
          expect(persisted).toContain('***REDACTED***');
        } finally {
          if (previousHome === undefined) delete process.env.HOME;
          else process.env.HOME = previousHome;
        }
      });
    });
  });

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

  it('reaps the process tree when an oversized diagnostic becomes fatal', async () => {
    let descendantPid = 0;
    const program = [
      "const { spawn } = require('node:child_process');",
      "const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 60_000)'], { stdio: 'ignore' });",
      'process.stderr.write("descendant:" + child.pid + "\\n");',
      'process.stderr.write("x".repeat(9000));',
      'setInterval(() => {}, 60_000);',
    ].join('');
    const result = await spawnAndCollect({
      command: 'node',
      args: ['-e', program],
      cwd: process.cwd(),
      onStderr: (chunk) => {
        const match = /descendant:(\d+)/.exec(chunk);
        if (match?.[1] !== undefined) descendantPid = Number.parseInt(match[1], 10);
      },
    });

    expect(result).toMatchObject({
      status: 'truncated',
      error: { code: 'stderr_line_overflow' },
    });
    expect(result.warnings).toContainEqual(
      expect.objectContaining({
        code: 'stderr_line_overflow',
        severity: 'warning',
        source: 'provider',
        surface: 'activity',
        message: 'stderr line exceeded 8192 bytes and was skipped',
      }),
    );
    expect(descendantPid).toBeGreaterThan(1);
    expect(() => process.kill(descendantPid, 0)).toThrow();
  });

  it('reports an oversized structured terminal result as a bounded truncation', async () => {
    const result = await spawnAndCollect({
      command: 'node',
      args: [
        '-e',
        `process.stdout.write(JSON.stringify({type:"result",result:"x".repeat(${
          DEFAULT_PROCESS_LINE_MAX_BYTES + 100
        })})+"\\n"); setInterval(() => {}, 60_000)`,
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

  it('returns a bounded truncation when a plain-text stdout line overflows', async () => {
    const result = await spawnAndCollect({
      command: 'node',
      args: [
        '-e',
        `process.stdout.write("x".repeat(${DEFAULT_PROCESS_LINE_MAX_BYTES + 100})); setInterval(() => {}, 60_000)`,
      ],
      cwd: process.cwd(),
    });

    expect(result).toMatchObject({
      status: 'truncated',
      text: '',
      error: { code: 'stdout_line_overflow' },
    });
    expect(result.warnings).toEqual([
      expect.objectContaining({
        code: 'stdout_line_overflow',
        severity: 'warning',
        source: 'system',
        surface: 'activity',
        message: expect.stringContaining('stdout line exceeded'),
      }),
    ]);
  });

  it('caps aggregate parsed stdout and reaps the producer on event overflow', async () => {
    const events: RunnerCallEvent[] = [];
    let descendantPid = 0;
    const program = [
      "const { spawn } = require('node:child_process');",
      "const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 60_000)'], { stdio: 'ignore' });",
      'process.stdout.write("descendant:" + child.pid + "\\n");',
      `for (let i = 0; i < ${RUNNER_CALL_OUTPUT_MAX_EVENTS + 10}; i += 1) console.log("x");`,
      'setInterval(() => {}, 60_000);',
    ].join('');
    const result = await spawnAndCollect({
      command: 'node',
      args: ['-e', program],
      cwd: process.cwd(),
      onText: (text) => {
        if (text.startsWith('descendant:')) {
          descendantPid = Number.parseInt(text.slice('descendant:'.length), 10);
        }
      },
      onCallEvent: (event) => events.push(event),
    });

    const textEvents = events.filter((event) => event.type === 'call_text_delta');
    expect(result).toMatchObject({
      status: 'truncated',
      error: { code: 'runner_output_text_limit' },
    });
    expect(textEvents).toHaveLength(RUNNER_CALL_OUTPUT_MAX_EVENTS);
    expect(descendantPid).toBeGreaterThan(1);
    expect(() => process.kill(descendantPid, 0)).toThrow();
  });

  it('idle warnings emit call_stalled and call_stall_cleared events', async () => {
    vi.useFakeTimers();
    try {
      const events: RunnerCallEvent[] = [];
      const promise = spawnAndCollect({
        command: 'node',
        args: ['-e', 'setTimeout(() => { console.log("late output"); }, 50)'],
        cwd: process.cwd(),
        onCallEvent: (event) => events.push(event),
        idle: { warnMs: 1_000, killMs: 600_000 },
      });

      vi.advanceTimersByTime(1_000);
      vi.useRealTimers();
      const result = await promise;

      expect(result.status).toBe('completed');
      expect(events).toContainEqual(
        expect.objectContaining({ type: 'call_stalled', silentMs: 1_000 }),
      );
      expect(events).toContainEqual(expect.objectContaining({ type: 'call_stall_cleared' }));
    } finally {
      vi.useRealTimers();
    }
  });

  it('an idle-killed call reaps its process tree before failing with runner_idle_timeout', async () => {
    const events: RunnerCallEvent[] = [];
    let leaderPid = 0;
    let descendantPid = 0;
    let absentAtRejection: { leader: boolean; descendant: boolean } | undefined;
    const processIsAbsent = (pid: number) => {
      try {
        process.kill(pid, 0);
        return false;
      } catch {
        return true;
      }
    };
    const leaderProgram = [
      "const { spawn } = require('node:child_process');",
      "const daemon = spawn(process.execPath, ['-e', 'setInterval(() => {}, 60_000)'], { stdio: 'ignore' });",
      'daemon.unref();',
      'process.stdout.write(String(process.pid) + ":" + String(daemon.pid) + "\\n");',
      'setInterval(() => {}, 60_000);',
    ].join('');
    const promise = spawnAndCollect({
      command: process.execPath,
      args: ['-e', leaderProgram],
      cwd: process.cwd(),
      onText: (text) => {
        const [leader, descendant] = text.trim().split(':');
        if (leader === undefined || descendant === undefined) return;
        leaderPid = Number.parseInt(leader, 10);
        descendantPid = Number.parseInt(descendant, 10);
      },
      onCallEvent: (event) => events.push(event),
      idle: { warnMs: 500, killMs: 1_000 },
    });
    const observedRejection = promise.catch((error: unknown) => {
      absentAtRejection = {
        leader: processIsAbsent(leaderPid),
        descendant: processIsAbsent(descendantPid),
      };
      throw error;
    });

    try {
      await expect(observedRejection).rejects.toMatchObject({ kind: 'command-idle-timeout' });

      expect(leaderPid).toBeGreaterThan(1);
      expect(descendantPid).toBeGreaterThan(1);
      expect(absentAtRejection).toEqual({ leader: true, descendant: true });

      const errors = runnerCallErrors(events);
      expect(runnerCallTerminals(events)).toHaveLength(1);
      expect(errors).toHaveLength(1);
      expect(errors[0]).toMatchObject({
        status: 'failed',
        error: {
          code: 'runner_idle_timeout',
          message: expect.stringContaining('produced no output for 1s'),
        },
      });
    } finally {
      for (const pid of [leaderPid, descendantPid]) {
        if (pid <= 1 || processIsAbsent(pid)) continue;
        process.kill(pid, 'SIGKILL');
      }
    }
  });

  it('enforces a hard deadline despite chatty output and reaps a stubborn process tree', async () => {
    const declaredValue = 'deadline-value-canary-c5e1';
    const events: RunnerCallEvent[] = [];
    const callbacks: string[] = [];
    let leaderPid = 0;
    let descendantPid = 0;
    let absentAtRejection: { leader: boolean; descendant: boolean } | undefined;
    let failure: unknown;
    const processIsAbsent = (pid: number) => {
      try {
        process.kill(pid, 0);
        return false;
      } catch {
        return true;
      }
    };
    const program = [
      "const { spawn } = require('node:child_process');",
      "const child = spawn(process.execPath, ['-e', 'process.on(\"SIGTERM\", () => {}); setInterval(() => {}, 60_000)'], { stdio: 'ignore' });",
      'process.stdout.write(String(process.pid) + ":" + String(child.pid) + "|" + process.env.CUSTOM_PUBLIC_VALUE + "\\n");',
      'setInterval(() => process.stdout.write("chatty\\n"), 5);',
    ].join('');
    const pending = spawnAndCollect({
      command: process.execPath,
      args: ['-e', program],
      cwd: process.cwd(),
      timeoutMs: 500,
      idle: { warnMs: 1_000, killMs: 2_000 },
      env: { CUSTOM_PUBLIC_VALUE: declaredValue },
      credentialValues: [declaredValue],
      redact: createCustomRunnerRedactor([declaredValue]),
      onText: (text) => {
        callbacks.push(text);
        const match = /(\d+):(\d+)/.exec(text);
        if (match?.[1] === undefined || match[2] === undefined) return;
        leaderPid = Number.parseInt(match[1], 10);
        descendantPid = Number.parseInt(match[2], 10);
      },
      onCallEvent: (event) => events.push(event),
    });
    const observedRejection = pending.catch((error: unknown) => {
      failure = error;
      absentAtRejection = {
        leader: processIsAbsent(leaderPid),
        descendant: processIsAbsent(descendantPid),
      };
      throw error;
    });

    try {
      await expect(observedRejection).rejects.toMatchObject({ kind: 'command-timeout' });

      expect(leaderPid).toBeGreaterThan(1);
      expect(descendantPid).toBeGreaterThan(1);
      expect(absentAtRejection).toEqual({ leader: true, descendant: true });
      expect(runnerCallErrors(events)).toEqual([
        expect.objectContaining({
          status: 'timeout',
          error: expect.objectContaining({ code: 'command-timeout' }),
        }),
      ]);
      const observedFailure =
        failure instanceof Error || failure instanceof DOMException
          ? {
              name: failure.name,
              message: failure.message,
              enumerable: Object.fromEntries(Object.entries(failure)),
            }
          : failure;
      expect(JSON.stringify({ callbacks, events, failure: observedFailure })).not.toContain(
        declaredValue,
      );
    } finally {
      for (const pid of [leaderPid, descendantPid]) {
        if (pid <= 1 || processIsAbsent(pid)) continue;
        process.kill(pid, 'SIGKILL');
      }
    }
  });

  it('clears hard-deadline timers after a successful collection', async () => {
    vi.useFakeTimers();
    try {
      const result = await spawnAndCollect({
        command: process.execPath,
        args: ['-e', 'process.stdout.write("done\\n")'],
        cwd: process.cwd(),
        timeoutMs: 60_000,
      });

      expect(result.status).toBe('completed');
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps an external TimeoutError abort classified as aborted and reaps its process tree', async () => {
    const controller = new AbortController();
    const declaredValue = 'external-timeout-value-canary-4ab9';
    const events: RunnerCallEvent[] = [];
    let leaderPid = 0;
    let descendantPid = 0;
    const processIsAbsent = (pid: number) => {
      try {
        process.kill(pid, 0);
        return false;
      } catch {
        return true;
      }
    };
    const program = [
      "const { spawn } = require('node:child_process');",
      "const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 60_000)'], { stdio: 'ignore' });",
      'process.stdout.write(String(process.pid) + ":" + String(child.pid) + "\\n");',
      'setInterval(() => process.stdout.write("chatty\\n"), 5);',
    ].join('');
    const pending = spawnAndCollect({
      command: process.execPath,
      args: ['-e', program],
      cwd: process.cwd(),
      timeoutMs: 60_000,
      signal: controller.signal,
      credentialValues: [declaredValue],
      redact: createCustomRunnerRedactor([declaredValue]),
      onText: (text) => {
        const match = /(\d+):(\d+)/.exec(text);
        if (match?.[1] === undefined || match[2] === undefined) return;
        leaderPid = Number.parseInt(match[1], 10);
        descendantPid = Number.parseInt(match[2], 10);
        controller.abort(new DOMException(`external-${declaredValue}`, 'TimeoutError'));
      },
      onCallEvent: (event) => events.push(event),
    });

    try {
      let failure: unknown;
      try {
        await pending;
      } catch (error) {
        failure = error;
      }
      const observedFailure =
        failure instanceof Error || failure instanceof DOMException
          ? {
              name: failure.name,
              message: failure.message,
              enumerable: Object.fromEntries(Object.entries(failure)),
            }
          : failure;

      expect(failure).toBeDefined();
      expect(leaderPid).toBeGreaterThan(1);
      expect(descendantPid).toBeGreaterThan(1);
      expect(processIsAbsent(leaderPid)).toBe(true);
      expect(processIsAbsent(descendantPid)).toBe(true);
      expect(runnerCallErrors(events)).toEqual([expect.objectContaining({ status: 'aborted' })]);
      expect(JSON.stringify({ events, failure: observedFailure })).not.toContain(declaredValue);
    } finally {
      for (const pid of [leaderPid, descendantPid]) {
        if (pid <= 1 || processIsAbsent(pid)) continue;
        process.kill(pid, 'SIGKILL');
      }
    }
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
