import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { invokeTestClaude } from '#testing/helpers/claude-planner-steer-test-invoke.js';
import { createClaudeCodePlanner } from '../../planners/claude-code.js';
import { join } from 'node:path';
import { DEFAULT_PROCESS_LINE_MAX_BYTES } from '../../../lib/process/spawn/lifecycle.js';
import { createTempDir, cleanupTempDir } from '#testing/helpers/temp-dir.js';
import type { RunnerCallEvent } from '../../calls/types.js';
import type { CliExecutableIdentity } from '../../../core/discovery/detection.js';
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
 * These tests exercise the real subprocess seam. Each test installs a shim
 * named `claude` in a temp directory and passes its trusted executable
 * identity to the invoke boundary. The shim emits real stream-json lines so
 * the invoke module's parse + state-aggregation path is observable end-to-end.
 */

let shimDir: string;
let projectDir: string;
let restorePath: () => void;

beforeEach(() => {
  shimDir = createTempDir('claude-runner-shim');
  projectDir = createTempDir('claude-runner-project');
  restorePath = prependPath(shimDir);
});

afterEach(() => {
  restorePath();
  cleanupTempDir(shimDir);
  cleanupTempDir(projectDir);
});

function trustedClaudeExecutable(): CliExecutableIdentity {
  const path = realpathSync(`${shimDir}/claude`);
  const info = statSync(path);
  return {
    path,
    fingerprint: {
      dev: info.dev,
      ino: info.ino,
      size: info.size,
      mtimeMs: info.mtimeMs,
    },
  };
}

function invokeTrustedClaude(
  opts: Parameters<typeof invokeTestClaude>[0],
): ReturnType<typeof invokeTestClaude> {
  return invokeTestClaude({ ...opts, executable: trustedClaudeExecutable() });
}

describe('shared Claude planner invocation', () => {
  it('records every tool fragment and shows a subagent answer once through the production planner', async () => {
    const fragments = ['{"file_path":"src/hello', ' world.ts"}'];
    const fragment = (partial_json: string) =>
      JSON.stringify({
        type: 'stream_event',
        event: {
          type: 'content_block_delta',
          index: 1,
          delta: { type: 'input_json_delta', partial_json },
        },
      });
    installClaudeShim(shimDir, [
      JSON.stringify({
        type: 'stream_event',
        event: {
          type: 'content_block_start',
          index: 1,
          content_block: { type: 'tool_use', id: 'tool-read', name: 'Read', input: {} },
        },
      }),
      ...fragments.map(fragment),
      JSON.stringify({
        type: 'stream_event',
        parent_tool_use_id: 'agent-1',
        event: {
          type: 'content_block_delta',
          delta: { type: 'text_delta', text: 'subagent answer' },
        },
      }),
      JSON.stringify({
        type: 'assistant',
        parent_tool_use_id: 'agent-1',
        message: { content: [{ type: 'text', text: 'subagent answer' }] },
      }),
      JSON.stringify({
        type: 'assistant',
        message: { content: [{ type: 'text', text: 'Main answer.' }] },
      }),
      JSON.stringify({ type: 'result', result: '' }),
    ]);
    const output: string[] = [];
    const events: RunnerCallEvent[] = [];
    const planner = createClaudeCodePlanner({
      authChannel: undefined,
      trustedCli: { executable: trustedClaudeExecutable() },
    });
    const result = await planner
      .typedCall({
        projectDir,
        seat: 'planner',
        callbacks: {
          onOutput: (text) => output.push(text),
          onCallEvent: (event) => events.push(event),
        },
      })
      .invoke({ prompt: 'Read the source and answer.' });
    const toolFragments = events
      .filter((event) => event.type === 'call_tool_use_delta')
      .filter((event) => event.toolUseId === 'tool-read' && fragments.includes(event.inputDelta));
    expect(toolFragments.map((event) => event.inputDelta).join('')).toBe(
      '{"file_path":"src/hello world.ts"}',
    );
    expect(toolFragments).toEqual([
      expect.objectContaining({
        toolUseId: 'tool-read',
        name: 'Read',
        inputDelta: '{"file_path":"src/hello',
      }),
      expect.objectContaining({
        toolUseId: 'tool-read',
        name: 'Read',
        inputDelta: ' world.ts"}',
      }),
    ]);
    expect(output).toEqual(['subagent answer', 'Main answer.']);
    expect(result.text).toBe('Main answer.');
    expect(
      events.filter(
        (event) => event.type === 'call_text_delta' && event.text === 'subagent answer',
      ),
    ).toEqual([
      expect.objectContaining({ channel: 'assistant', subagentId: 'agent-1', semantics: 'delta' }),
    ]);
  });

  it.each(['last segment', 'empty terminal'])(
    'rebuilds the 563-character continuation through the production planner with %s',
    async (terminal) => {
      const fixtures = join(import.meta.dirname, '../../../../testing/fixtures/claude-code');
      const lines = readFileSync(join(fixtures, 'claude-planner-max-tokens.jsonl'), 'utf8')
        .trim()
        .split('\n');
      if (terminal === 'empty terminal')
        lines[lines.length - 1] = JSON.stringify({ type: 'result', result: '' });
      installClaudeShim(shimDir, lines);
      const expected = readFileSync(
        join(fixtures, 'claude-planner-max-tokens.expected.txt'),
        'utf8',
      );
      const planner = createClaudeCodePlanner({
        authChannel: undefined,
        trustedCli: { executable: trustedClaudeExecutable() },
      });
      const result = await planner
        .typedCall({ projectDir, seat: 'planner', callbacks: { onOutput: () => {} } })
        .invoke({ prompt: 'continue the document' });
      expect(expected).toHaveLength(563);
      expect(result.text).toBe(expected);
    },
  );

  it.each(['### Verdict\npass', ''])(
    'keeps a continuation across tool calls through the production planner with terminal %j',
    async (terminal) => {
      const message = (id: string, text: string, stopReason: string) => [
        JSON.stringify({
          type: 'stream_event',
          event: { type: 'message_start', message: { id, content: [] } },
        }),
        JSON.stringify({ type: 'assistant', message: { id, content: [{ type: 'text', text }] } }),
        JSON.stringify({
          type: 'stream_event',
          event: { type: 'message_delta', delta: { stop_reason: stopReason } },
        }),
      ];
      installClaudeShim(shimDir, [
        ...message('narration', 'Reading the diff.', 'tool_use'),
        ...message('cut', '## Review\n\nCut mid-', 'max_tokens'),
        ...message('resume', 'sentence.', 'tool_use'),
        JSON.stringify({
          type: 'assistant',
          message: {
            content: [
              { type: 'tool_use', id: 'read', name: 'Read', input: { file_path: 'src/a.ts' } },
            ],
          },
        }),
        JSON.stringify({
          type: 'user',
          message: { content: [{ type: 'tool_result', tool_use_id: 'read', content: 'source' }] },
        }),
        ...message('verdict', '### Verdict\npass', 'end_turn'),
        JSON.stringify({ type: 'result', result: terminal }),
      ]);
      const planner = createClaudeCodePlanner({
        authChannel: undefined,
        trustedCli: { executable: trustedClaudeExecutable() },
      });
      const result = await planner
        .typedCall({ projectDir, seat: 'planner', callbacks: { onOutput: () => {} } })
        .invoke({ prompt: 'review' });
      expect(result.text).toBe('## Review\n\nCut mid-sentence.\n\n### Verdict\npass');
      expect(result.toolUses).toContainEqual(expect.objectContaining({ id: 'read', name: 'Read' }));
    },
  );

  it('keeps narration and subagent messages out of a terminal without text', async () => {
    const fixtures = join(import.meta.dirname, '../../../../testing/fixtures/claude-code');
    const lines = readFileSync(join(fixtures, 'claude-planner-narration.jsonl'), 'utf8')
      .trim()
      .split('\n');
    lines.splice(
      lines.length - 1,
      1,
      JSON.stringify({
        type: 'assistant',
        parent_tool_use_id: 'agent',
        message: { content: [{ type: 'text', text: 'Subagent output' }] },
      }),
      JSON.stringify({ type: 'result', result: '' }),
    );
    installClaudeShim(shimDir, lines);
    const chunks: string[] = [];
    const planner = createClaudeCodePlanner({
      authChannel: undefined,
      trustedCli: { executable: trustedClaudeExecutable() },
    });
    const result = await planner
      .typedCall({
        projectDir,
        seat: 'planner',
        callbacks: { onOutput: (text) => chunks.push(text) },
      })
      .invoke({ prompt: 'write the document' });
    expect(result.text).toBe(
      readFileSync(join(fixtures, 'claude-planner-narration.expected.txt'), 'utf8'),
    );
    expect(chunks.join('')).toContain('Subagent output');
    expect(chunks.join('')).toContain("I'll start by looking at the commits");
  });

  it('reports an abort with a non-error reason as a typed failure', async () => {
    installClaudeShim(shimDir, ['{"type":"result","result":"should not run"}']);
    const controller = new AbortController();
    controller.abort('cancelled');
    await expect(
      invokeTrustedClaude({
        prompt: 'p',
        projectDir,
        onOutput: () => {},
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ kind: 'runner-call-failed', data: { status: 'aborted' } });
  });

  it('accumulates streamed text and captures session id + usage from result event', async () => {
    installClaudeShim(shimDir, [
      '{"type":"system","session_id":"sess-abc"}',
      '{"type":"assistant","message":{"content":[{"type":"text","text":"Hello "}]}}',
      '{"type":"assistant","message":{"content":[{"type":"text","text":"world"}]}}',
      '{"type":"result","result":"Hello world","session_id":"sess-abc","usage":{"input_tokens":42,"output_tokens":7}}',
    ]);

    const chunks: string[] = [];
    const result = await invokeTrustedClaude({
      prompt: 'do thing',
      projectDir,
      sessionId: null,
      onOutput: (text) => chunks.push(text),
    });

    expect(result.nativeSessionId).toBe('sess-abc');
    expect(result.usage).toEqual({
      inputTokens: 42,
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
    expect(chunks).toEqual(['Hello ', 'world']);
    expect(result.text).toBe('Hello world');
  });

  it('streams only the missing suffix when the final result extends streamed text', async () => {
    installClaudeShim(shimDir, [
      '{"type":"assistant","message":{"content":[{"type":"text","text":"Hello"}]}}',
      '{"type":"result","result":"Hello world"}',
    ]);

    const chunks: string[] = [];
    const result = await invokeTrustedClaude({
      prompt: 'do thing',
      projectDir,
      sessionId: null,
      onOutput: (text) => chunks.push(text),
    });

    expect(chunks).toEqual(['Hello', ' world']);
    expect(result.text).toBe('Hello world');
  });

  it('records divergent final result text as a typed replacement and streams the final answer', async () => {
    installClaudeShim(shimDir, [
      '{"type":"assistant","message":{"content":[{"type":"text","text":"draft text"}]}}',
      '{"type":"result","result":"final text"}',
    ]);

    const chunks: string[] = [];
    const events: RunnerCallEvent[] = [];
    const result = await invokeTrustedClaude({
      prompt: 'do thing',
      projectDir,
      sessionId: null,
      onOutput: (text) => chunks.push(text),
      onCallEvent: (event) => events.push(event),
    });

    expect(chunks).toEqual(['draft text', 'final text']);
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

    const result = await invokeTrustedClaude({
      prompt: 'p',
      projectDir,
      sessionId: 'pre-existing-session',
      onOutput: () => {},
    });

    expect(result.nativeSessionId).toBe('pre-existing-session');
  });

  it('emits tool-use events without writing tool summaries to output text', async () => {
    installClaudeShim(shimDir, [
      '{"type":"assistant","message":{"content":[{"type":"tool_use","id":"tool-read","name":"Read","input":{"file_path":"/etc/hosts"}}]}}',
      '{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"tool-read"}]}}',
      '{"type":"assistant","message":{"content":[{"type":"tool_use","id":"tool-bash","name":"Bash","input":{"command":"ls -la"}}]}}',
      '{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"tool-bash"}]}}',
      '{"type":"result","result":""}',
    ]);

    const chunks: string[] = [];
    const events: RunnerCallEvent[] = [];
    await invokeTrustedClaude({
      prompt: 'p',
      projectDir,
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
    await invokeTrustedClaude({
      prompt: 'p',
      projectDir,
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

  it('rejects before spawning when no trusted executable identity is supplied', async () => {
    const markerFile = `${shimDir}/started`;
    installClaudeNodeShim(
      shimDir,
      `require('node:fs').writeFileSync(${JSON.stringify(markerFile)}, 'started');
process.stdout.write(JSON.stringify({ type: 'result', result: 'unexpected' }) + '\\n');`,
    );
    const events: RunnerCallEvent[] = [];
    await expect(
      invokeTestClaude({
        prompt: 'p',
        projectDir,
        sessionId: null,
        onOutput: () => {},
        onCallEvent: (event) => events.push(event),
      }),
    ).rejects.toMatchObject({ kind: 'cli-executable-untrusted' });
    expect(existsSync(markerFile)).toBe(false);
    expect(events).toEqual([]);
    expect(replayRunnerCallEventsIntoOperations(events).active).toBeNull();
  });

  it('rejects without spawning when the signal is already aborted', async () => {
    installClaudeShim(shimDir, ['{"type":"result","result":"should not run"}']);
    const controller = new AbortController();
    controller.abort(new Error('cancelled'));

    await expect(
      invokeTrustedClaude({
        prompt: 'p',
        projectDir,
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
      invokeTrustedClaude({
        prompt: 'p',
        projectDir,
        sessionId: null,
        onOutput: () => {},
      }),
    ).rejects.toMatchObject({
      kind: 'runner-call-failed',
      message: expect.stringContaining('Credit balance is too low'),
    });
  });

  it('surfaces an is_error result as a failure even when claude exits 0', async () => {
    installClaudeShim(shimDir, [
      '{"type":"system","session_id":"sess-zero"}',
      '{"type":"result","is_error":true,"result":"Overloaded: please retry","session_id":"sess-zero"}',
    ]);

    await expect(
      invokeTrustedClaude({
        prompt: 'p',
        projectDir,
        sessionId: null,
        onOutput: () => {},
      }),
    ).rejects.toMatchObject({
      kind: 'runner-call-failed',
      message: expect.stringContaining('Overloaded: please retry'),
    });
  });

  it('an idle-killed call finishes failed with code no-progress-cut', async () => {
    installClaudeSlowShim(shimDir, ['{"type":"system","session_id":"sess-idle"}']);

    const events: RunnerCallEvent[] = [];
    await expect(
      invokeTrustedClaude({
        prompt: 'p',
        projectDir,
        sessionId: null,
        onOutput: () => {},
        onCallEvent: (event) => events.push(event),
        idleWarnMs: 40,
        idleKillMs: 120,
      }),
    ).rejects.toMatchObject({
      kind: 'runner-call-failed',
      data: { error: { code: 'no-progress-cut' } },
    });

    const errors = runnerCallErrors(events);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({
      status: 'failed',
      error: { code: 'no-progress-cut' },
    });
  });

  it('emits one call_error for a stream that exits 0 without a result terminal', async () => {
    installClaudeShim(shimDir, [
      '{"type":"assistant","message":{"content":[{"type":"text","text":"partial"}]}}',
    ]);

    const chunks: string[] = [];
    const events: RunnerCallEvent[] = [];
    await expect(
      invokeTrustedClaude({
        prompt: 'p',
        projectDir,
        sessionId: null,
        onOutput: (text) => chunks.push(text),
        onCallEvent: (event) => events.push(event),
      }),
    ).rejects.toMatchObject({
      kind: 'runner-call-failed',
      message: expect.stringContaining('without its required terminal result'),
    });

    expect(chunks.join('')).toContain('partial');
    const errors = runnerCallErrors(events);
    expect(runnerCallTerminals(events)).toHaveLength(1);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({
      status: 'incomplete',
      error: { code: 'protocol-failure' },
      partial: true,
    });
    const operations = replayRunnerCallEventsIntoOperations(events);
    expect(operations.active).toBeNull();
    expect(operations.last).toMatchObject({
      callId: errors[0]?.callId,
      status: 'incomplete',
      reason: 'CLI ended without its required terminal result',
      partial: true,
    });
  });

  it('skips an oversized stdout line with a warning and completes on a valid terminal', async () => {
    installClaudeNodeShim(
      shimDir,
      `
process.stdout.write("x".repeat(${DEFAULT_PROCESS_LINE_MAX_BYTES + 100}) + "\\n");
process.stdout.write(JSON.stringify({ type: "result", result: "ok" }) + "\\n");
`,
    );

    const events: RunnerCallEvent[] = [];
    const result = await invokeTrustedClaude({
      prompt: 'p',
      projectDir,
      sessionId: null,
      onOutput: () => {},
      onCallEvent: (event) => events.push(event),
    });

    expect(result.status).toBe('completed');
    expect(result.text).toBe('ok');
    const errors = runnerCallErrors(events);
    expect(runnerCallTerminals(events)).toHaveLength(1);
    expect(errors).toHaveLength(0);
    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'call_warning',
        warning: expect.objectContaining({
          code: 'stdout_line_overflow',
          message: expect.stringContaining('stdout line exceeded'),
        }),
      }),
    );
    expect(events.filter((event) => event.type === 'call_warning')).toHaveLength(1);
  });

  // The 4096-event output cap was dropped: it ended healthy calls that simply
  // streamed in small pieces. Only the byte bound remains, and 5000 one-character
  // chunks are nowhere near it, so the whole reply reaches the caller.
  it('streams many small assistant chunks in full, with no per-event cap', async () => {
    installClaudeNodeShim(
      shimDir,
      `
for (let i = 0; i < 5000; i += 1) {
  process.stdout.write(JSON.stringify({
    type: "assistant",
    message: { content: [{ type: "text", text: "x" }] }
  }) + "\\n");
}
process.stdout.write(JSON.stringify({
  type: "result",
  result: "x".repeat(5000)
}) + "\\n");
`,
    );

    const chunks: string[] = [];
    const events: RunnerCallEvent[] = [];
    const result = await invokeTrustedClaude({
      prompt: 'p',
      projectDir,
      sessionId: null,
      onOutput: (text) => chunks.push(text),
      onCallEvent: (event) => events.push(event),
    });

    expect(result.status).toBe('completed');
    expect(result.text).toBe('x'.repeat(5000));
    const textEvents = events.filter(
      (event) => event.type === 'call_text_delta' && event.channel === 'assistant',
    );
    const errors = runnerCallErrors(events);
    expect(chunks.join('')).toBe('x'.repeat(5000));
    expect(textEvents).toHaveLength(5000);
    expect(runnerCallTerminals(events)).toHaveLength(1);
    expect(errors).toHaveLength(0);
    expect(
      events.filter(
        (event) => event.type === 'call_warning' && event.warning.code.endsWith('_text_limit'),
      ),
    ).toHaveLength(0);
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
      invokeTrustedClaude({
        prompt: 'p',
        projectDir,
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
      error: { code: 'user-abort', message: 'CLI invocation was aborted' },
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
      invokeTrustedClaude({
        prompt: 'p',
        projectDir,
        sessionId: null,
        onOutput: () => {},
        signal: AbortSignal.timeout(20),
      }),
    ).rejects.toMatchObject({ name: 'TimeoutError' });
  });

  it('sends image attachments outside the project as stream-json content blocks', async () => {
    const { argvFile, stdinFile } = installClaudeRecordingShim(shimDir);
    const firstPath = join(shimDir, 'a.png');
    const secondPath = join(shimDir, 'b.data');
    const firstBytes = Buffer.from([137, 80, 78, 71, 0, 255]);
    const secondBytes = Buffer.from([255, 216, 255, 0, 128]);
    writeFileSync(firstPath, firstBytes);
    writeFileSync(secondPath, secondBytes);
    const images = [
      { ...makeClaudeTestImage(firstPath), sizeBytes: firstBytes.length },
      { ...makeClaudeTestImage(secondPath), mimeType: 'image/jpeg', sizeBytes: secondBytes.length },
    ];

    await invokeTrustedClaude({
      prompt: 'describe the screenshot',
      projectDir,
      sessionId: null,
      onOutput: () => {},
      images,
    });

    const argv = readFileSync(argvFile, 'utf8');
    const stdin = readFileSync(stdinFile, 'utf8');

    expect(argv).not.toContain('--image');
    expect(argv).not.toContain(firstPath);
    expect(argv.split('\n')).toEqual(expect.arrayContaining(['--input-format', 'stream-json']));
    expect(stdin).toBe(
      JSON.stringify({
        type: 'user',
        message: {
          role: 'user',
          content: [
            { type: 'text', text: 'describe the screenshot' },
            {
              type: 'image',
              source: {
                type: 'base64',
                media_type: 'image/png',
                data: firstBytes.toString('base64'),
              },
            },
            {
              type: 'image',
              source: {
                type: 'base64',
                media_type: 'image/jpeg',
                data: secondBytes.toString('base64'),
              },
            },
          ],
        },
      }) + '\n',
    );
  });

  it('passes effort as an --effort argv flag, never as an /effort stdin prefix', async () => {
    const { argvFile, stdinFile } = installClaudeRecordingShim(shimDir);

    await invokeTrustedClaude({
      prompt: 'go',
      projectDir,
      sessionId: null,
      onOutput: () => {},
      effort: 'high',
    });

    const argv = readFileSync(argvFile, 'utf8').split('\n');
    const stdin = readFileSync(stdinFile, 'utf8');

    const effortIdx = argv.indexOf('--effort');
    expect(effortIdx).toBeGreaterThanOrEqual(0);
    expect(argv[effortIdx + 1]).toBe('high');

    expect(stdin).not.toContain('/effort');
    expect(stdin).toBe('go');
    expect(argv).not.toContain('--input-format');
  });

  it("hands the planner the run's global skills to read, never to write", async () => {
    const { argvFile } = installClaudeRecordingShim(shimDir);
    const root = '/home/me/.claude/skills/auth';

    await invokeTrustedClaude({
      prompt: 'go',
      projectDir,
      sessionId: null,
      onOutput: () => {},
      skillRoots: [root],
    });

    const argv = readFileSync(argvFile, 'utf8').split('\n');
    const settings = JSON.parse(argv[argv.indexOf('--settings') + 1] ?? '');
    expect(settings.permissions).toEqual({
      additionalDirectories: [root],
      deny: [`Edit(/${root})`, `Edit(/${root}/**)`],
    });
  });

  it('omits the --effort flag entirely when no effort is configured', async () => {
    const { argvFile } = installClaudeRecordingShim(shimDir);

    await invokeTrustedClaude({
      prompt: 'go',
      projectDir,
      sessionId: null,
      onOutput: () => {},
    });

    const argv = readFileSync(argvFile, 'utf8');
    expect(argv).not.toContain('--effort');
  });
});
