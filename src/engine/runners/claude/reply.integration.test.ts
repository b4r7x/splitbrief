import { readFileSync, realpathSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { invokeTestClaude } from '#testing/helpers/claude-planner-steer-test-invoke.js';
import { installClaudeShim } from '#testing/helpers/claude-cli-shim.js';
import { prependPath } from '#testing/helpers/command-shim.js';
import { cleanupTempDir, createTempDir } from '#testing/helpers/temp-dir.js';
import type { RunnerCallEvent } from '../../calls/types.js';
import { projectRunnerCallEvents } from '../../calls/event-projection.js';
import { RUNNER_CALL_OUTPUT_MAX_BYTES } from '../../calls/output-limit.js';

let shimDir: string;
let projectDir: string;
let restorePath: () => void;

beforeEach(() => {
  shimDir = createTempDir('claude-reply-shim');
  projectDir = createTempDir('claude-reply-project');
  restorePath = prependPath(shimDir);
});

afterEach(() => {
  restorePath();
  cleanupTempDir(shimDir);
  cleanupTempDir(projectDir);
});

function invokeReply(
  lines: readonly string[],
  opts: Omit<Parameters<typeof invokeTestClaude>[0], 'prompt' | 'projectDir' | 'executable'> = {
    onOutput: () => {},
  },
) {
  const path = realpathSync(installClaudeShim(shimDir, [...lines]));
  const { dev, ino, size, mtimeMs } = statSync(path);
  return invokeTestClaude({
    ...opts,
    prompt: 'Reply to the test prompt.',
    projectDir,
    executable: { path, fingerprint: { dev, ino, size, mtimeMs } },
  });
}

describe('Claude stream credential redaction', () => {
  it('redacts credential values from output callbacks, tool payloads, events, and results', async () => {
    const credential = 'opaque-claude-credential-canary-7d93c612';
    const output: string[] = [];
    const events: RunnerCallEvent[] = [];
    const result = await invokeReply(
      [
        JSON.stringify({
          type: 'assistant',
          message: {
            content: [
              { type: 'text', text: `answer ${credential}` },
              { type: 'tool_use', id: credential, name: 'debug', input: { credential } },
            ],
          },
        }),
        JSON.stringify({ type: 'result', result: `answer ${credential}` }),
      ],
      {
        authChannel: 'api-key',
        env: { PATH: process.env.PATH, ANTHROPIC_API_KEY: credential },
        onOutput: (text) => output.push(text),
        onCallEvent: (event) => events.push(event),
      },
    );
    const persisted = JSON.stringify({ result, events, output });
    expect(persisted).not.toContain(credential);
    expect(persisted).toContain('***REDACTED***');
    expect(output).toEqual(['answer ***REDACTED***']);
    expect(result.text).toBe('answer ***REDACTED***');
  });

  it('redacts credential values from in-band failure diagnostics', async () => {
    const credential = 'opaque-claude-error-credential-canary-7d93c612';
    const events: RunnerCallEvent[] = [];
    await expect(
      invokeReply([JSON.stringify({ type: 'result', is_error: true, result: credential })], {
        authChannel: 'api-key',
        env: { PATH: process.env.PATH, ANTHROPIC_API_KEY: credential },
        onOutput: () => {},
        onCallEvent: (event) => events.push(event),
      }),
    ).rejects.toThrow('***REDACTED***');
    const persisted = JSON.stringify(events);
    expect(persisted).not.toContain(credential);
    expect(persisted).toContain('***REDACTED***');
  });

  it('streams a partial message once when the assistant record restates it', async () => {
    const deltas = ['returning `a', ' - b`', '\n\n', 'second para.'];
    const message = deltas.join('');
    const output: string[] = [];
    const result = await invokeReply(
      [
        ...deltas.map((text) =>
          JSON.stringify({
            type: 'stream_event',
            session_id: 'sess-partial',
            event: { type: 'content_block_delta', delta: { type: 'text_delta', text } },
          }),
        ),
        JSON.stringify({
          type: 'assistant',
          session_id: 'sess-partial',
          message: { content: [{ type: 'text', text: message }] },
        }),
        JSON.stringify({ type: 'result', session_id: 'sess-partial', result: message }),
      ],
      { onOutput: (text) => output.push(text) },
    );

    expect(output.join('')).toBe(message);
    expect(result.text).toBe(message);
  });

  it('returns a typed, redacted interruption while preserving timeout taxonomy', async () => {
    const credential = 'opaque-claude-interrupt-credential-canary-7d93c612';
    const controller = new AbortController();
    controller.abort(new DOMException(`cancelled with ${credential}`, 'TimeoutError'));

    const interrupted = await invokeReply([], {
      signal: controller.signal,
      authChannel: 'api-key',
      env: { PATH: process.env.PATH, ANTHROPIC_API_KEY: credential },
      onOutput: () => {},
    }).catch((cause: unknown) => cause);

    expect(interrupted).toMatchObject({
      kind: 'runner-interrupted',
      name: 'TimeoutError',
      message: 'cancelled with ***REDACTED***',
      data: { status: 'timeout', name: 'TimeoutError' },
    });
    expect(JSON.stringify(interrupted)).not.toContain(credential);
  });

  it('carries structured_output from a schema-constrained result record to the completed call', async () => {
    const result = await invokeReply([
      '{"type":"result","subtype":"success","is_error":false,"result":"","session_id":"s-1","structured_output":{"answer":"ok","count":2}}',
    ]);
    if (result.status !== 'completed') throw new Error('expected a completed result');
    expect(result.structured).toEqual({ answer: 'ok', count: 2 });
  });

  it('keeps only the divergent final response as content, never concatenating partials', async () => {
    const result = await invokeReply([
      JSON.stringify({
        type: 'assistant',
        message: { content: [{ type: 'text', text: 'draft text' }] },
      }),
      JSON.stringify({ type: 'result', result: 'final text' }),
    ]);
    expect(result.status).toBe('completed');
    expect(result.text).toBe('final text');
  });
});

it('keeps the frames Claude Code keeps for itself out of the reply and the activity feed', async () => {
  const output: string[] = [];
  const events: RunnerCallEvent[] = [];
  const frame = (subtype: string, fields: Record<string, unknown> = {}): string =>
    JSON.stringify({ type: 'system', subtype, session_id: 'sess-frames', ...fields });

  const result = await invokeReply(
    [
      frame('hook_started', { hook_id: 'hook-1', hook_name: 'SessionStart:startup' }),
      frame('init'),
      frame('status', { status: 'requesting' }),
      frame('api_retry', {
        attempt: 3,
        max_retries: 10,
        retry_delay_ms: 8000,
        error_status: 429,
        error: 'rate_limit',
      }),
      frame('thinking_tokens', { estimated_tokens: 40, estimated_tokens_delta: 40 }),
      ...mainLoopMessage('msg-frames', 'Reading the fixture readers.', 'end_turn'),
      frame('task_notification', { task_id: 'task-1', status: 'completed', summary: 'done' }),
      JSON.stringify({ type: 'result', result: 'Reading the fixture readers.' }),
    ],
    {
      onOutput: (text) => output.push(text),
      onCallEvent: (event) => events.push(event),
    },
  );
  const activity = events
    .flatMap((event) =>
      projectRunnerCallEvents(event, { rootDir: '/project', phase: 'planning', sequence: 0 }),
    )
    .flatMap((event) => (event.type === 'runner_call_activity' ? [event] : []));

  expect(output.join('')).toBe('Reading the fixture readers.');
  expect(result.text).toBe('Reading the fixture readers.');
  expect(activity.map((event) => event.label)).not.toContain('system activity');
  expect(activity).toContainEqual(
    expect.objectContaining({
      kind: 'warning',
      label: 'warning',
      diagnosticPartial: 'rate_limit (HTTP 429): retry 3 of 10 in 8.0s',
    }),
  );
  // The bookkeeping frames keep the call fresh; the retry is a warning.
  expect(events.some((event) => event.type === 'call_heartbeat')).toBe(true);
  expect(result.warnings.map((warning) => warning.code)).toEqual(['claude_api_retry']);
});

it('observes matching native init and reports the seeded resume ID once', async () => {
  const initialized: string[] = [];
  const persisted: string[] = [];
  const reported: string[] = [];
  const sessionId = 'sess-old';
  await invokeReply(
    [
      JSON.stringify({ type: 'system', subtype: 'init', session_id: sessionId }),
      JSON.stringify({ type: 'assistant', session_id: sessionId, message: { content: [] } }),
      JSON.stringify({ type: 'result', session_id: sessionId, result: 'done' }),
    ],
    {
      sessionId,
      onOutput: () => {},
      onSessionInit: (id) => initialized.push(id),
      onSessionId: (id) => {
        reported.push(id);
        if (id !== sessionId) persisted.push(id);
      },
    },
  );
  expect(initialized).toEqual(['sess-old']);
  expect(persisted).toEqual([]);
  expect(reported).toEqual(['sess-old']);
});

const FIXTURES = join(import.meta.dirname, '../../../../testing/fixtures/claude-code');

function readFixture(name: string): string {
  return readFileSync(join(FIXTURES, name), 'utf8');
}

/** What the live transcript received, and the text the call returns. */
async function replay(lines: readonly string[]): Promise<{ output: string; text: string }> {
  const output: string[] = [];
  const result = await invokeReply(lines, {
    onOutput: (text) => output.push(text),
  });
  return { output: output.join(''), text: result.text };
}

function streamEvent(event: Record<string, unknown>, parent: string | null = null): string {
  return JSON.stringify({ type: 'stream_event', event, parent_tool_use_id: parent });
}

function textDelta(text: string): string {
  return streamEvent({
    type: 'content_block_delta',
    index: 0,
    delta: { type: 'text_delta', text },
  });
}

function assistantRecord(id: string, text: string, parent: string | null = null): string {
  return JSON.stringify({
    type: 'assistant',
    message: { id, content: [{ type: 'text', text }] },
    parent_tool_use_id: parent,
  });
}

function mainLoopMessage(id: string, text: string, stopReason: string): string[] {
  const deltas: string[] = [];
  for (let offset = 0; offset < text.length; offset += 256 * 1024) {
    deltas.push(textDelta(text.slice(offset, offset + 256 * 1024)));
  }
  return [
    streamEvent({ type: 'message_start', message: { id, content: [] } }),
    ...deltas,
    ...(text.length <= 256 * 1024 ? [assistantRecord(id, text)] : []),
    streamEvent({ type: 'message_delta', delta: { stop_reason: stopReason } }),
    streamEvent({ type: 'message_stop' }),
  ];
}

describe('Claude stream final text', async () => {
  it('returns the document alone while the narration before it still streams live', async () => {
    const { output, text } = await replay(
      readFixture('claude-planner-narration.jsonl').split('\n'),
    );

    expect(text).toBe(readFixture('claude-planner-narration.expected.txt'));
    expect(output).toContain('Checking three details the spec must state precisely');
    expect(output).toContain("I'll start by looking at the commits");
  });

  it('keeps a document that max_tokens split across two messages whole', async () => {
    const { text } = await replay(readFixture('claude-planner-max-tokens.jsonl').split('\n'));

    expect(text).toBe(readFixture('claude-planner-max-tokens.expected.txt'));
  });

  it('does not let a subagent record between main-loop deltas replay the block', async () => {
    const { output, text } = await replay([
      streamEvent({ type: 'message_start', message: { id: 'msg_main', content: [] } }),
      textDelta('Hel'),
      assistantRecord('msg_sub_1', ' [first] ', 'toolu_agent'),
      textDelta('lo'),
      assistantRecord('msg_sub_2', ' [second]', 'toolu_agent'),
      assistantRecord('msg_main', 'Hello'),
      streamEvent({ type: 'message_delta', delta: { stop_reason: 'end_turn' } }),
      JSON.stringify({ type: 'result', result: 'Hello' }),
    ]);

    expect(text).toBe('Hello');
    expect(output).toBe('Hel [first] lo [second]');
  });

  it('keeps narration out of the final verdict line', async () => {
    const verdict = 'VERDICT: widen a.ts — r';
    const { text } = await replay([
      ...mainLoopMessage('msg_narration', 'Reading the failing test before deciding.', 'tool_use'),
      ...mainLoopMessage('msg_verdict', verdict, 'end_turn'),
      JSON.stringify({ type: 'result', result: verdict }),
    ]);

    expect(text).toBe(verdict);
  });

  it('keeps narration out of a final verdict heading', async () => {
    const review = '### Verdict\npass';
    const { text } = await replay([
      ...mainLoopMessage('msg_narration', 'Checking the gates once more.', 'tool_use'),
      ...mainLoopMessage('msg_review', review, 'end_turn'),
      JSON.stringify({ type: 'result', result: review }),
    ]);

    expect(text).toBe(review);
  });

  it.each([
    ['an empty result', { type: 'result', result: '' }],
    ['a result without text', { type: 'result' }],
  ])('takes the last main-loop message, not the narration, from %s', async (_label, result) => {
    const verdict = 'VERDICT: widen a.ts — r';
    const { output, text } = await replay([
      ...mainLoopMessage('msg_narration', 'Reading the failing test before deciding.', 'tool_use'),
      ...mainLoopMessage('msg_verdict', verdict, 'end_turn'),
      JSON.stringify(result),
    ]);

    expect(text).toBe(verdict);
    expect(output).toContain('Reading the failing test before deciding.');
  });

  it('keeps the max_tokens chain behind the last message when the result has no text', async () => {
    const { text } = await replay([
      ...mainLoopMessage('msg_cut', '## Spec\n\nThe first half, cut mid-', 'max_tokens'),
      ...mainLoopMessage('msg_rest', 'sentence and the rest.', 'end_turn'),
      JSON.stringify({ type: 'result', result: '' }),
    ]);

    expect(text).toBe('## Spec\n\nThe first half, cut mid-sentence and the rest.');
  });

  it('takes the last message that had text when the turn ends on one without any', async () => {
    const verdict = 'VERDICT: widen a.ts — r';
    const { text } = await replay([
      ...mainLoopMessage('msg_narration', 'Reading the failing test before deciding.', 'tool_use'),
      ...mainLoopMessage('msg_verdict', verdict, 'tool_use'),
      streamEvent({ type: 'message_start', message: { id: 'msg_empty', content: [] } }),
      streamEvent({ type: 'message_delta', delta: { stop_reason: 'end_turn' } }),
      streamEvent({ type: 'message_stop' }),
      JSON.stringify({ type: 'result', result: '' }),
    ]);

    expect(text).toBe(verdict);
  });

  // claude-code answers `max_tokens` with "Output token limit hit. Resume directly" and a new
  // message that has every tool, so the continuation of a cut document can call one.
  it('carries a max_tokens chain across a tool call its continuation makes', async () => {
    const last = '### Verdict\npass';
    const { text } = await replay([
      ...mainLoopMessage('msg_narration', 'Reading the diff first.', 'tool_use'),
      ...mainLoopMessage('msg_cut', '## Review\n\nCriteria one, cut mid-', 'max_tokens'),
      ...mainLoopMessage('msg_resume', 'sentence; criteria two.', 'tool_use'),
      ...mainLoopMessage('msg_last', last, 'end_turn'),
      JSON.stringify({ type: 'result', result: last }),
    ]);

    expect(text).toBe(
      '## Review\n\nCriteria one, cut mid-sentence; criteria two.\n\n### Verdict\npass',
    );
  });

  it('closes the chain on end_turn so a later turn does not carry it', async () => {
    const { text } = await replay([
      ...mainLoopMessage('msg_cut', 'first turn, cut', 'max_tokens'),
      ...mainLoopMessage('msg_end', ' and ended.', 'end_turn'),
      ...mainLoopMessage('msg_next', 'Next turn.', 'end_turn'),
      JSON.stringify({ type: 'result', result: 'Next turn.' }),
    ]);

    expect(text).toBe('Next turn.');
  });
});

describe('Claude stream text budget', () => {
  function record(lines: readonly string[]) {
    const events: RunnerCallEvent[] = [];
    const finish = () =>
      invokeReply(lines, {
        onOutput: () => {},
        onCallEvent: (event) => events.push(event),
      });
    return { events, finish };
  }

  const textLimitWarnings = (events: readonly RunnerCallEvent[]) =>
    events.filter(
      (event) => event.type === 'call_warning' && event.warning.code.endsWith('_text_limit'),
    );

  it('does not warn about narration past the budget when the final text fits', async () => {
    const verdict = 'VERDICT: brief — r';
    const { events, finish } = record([
      ...mainLoopMessage('msg_narration', 'n'.repeat(RUNNER_CALL_OUTPUT_MAX_BYTES + 1), 'tool_use'),
      ...mainLoopMessage('msg_verdict', verdict, 'end_turn'),
      JSON.stringify({ type: 'result', result: verdict }),
    ]);

    expect(await finish()).toMatchObject({ status: 'completed', text: verdict, warnings: [] });
    expect(textLimitWarnings(events)).toEqual([]);
  });

  it('warns once when the text the call ends with was cut', async () => {
    const { events, finish } = record([
      streamEvent({ type: 'message_start', message: { id: 'msg_long', content: [] } }),
      ...Array.from({ length: 4 }, () => textDelta('x'.repeat(RUNNER_CALL_OUTPUT_MAX_BYTES / 4))),
      textDelta('x'),
      JSON.stringify({ type: 'result', result: '' }),
    ]);

    await expect(finish()).rejects.toThrow('Claude runner call truncated');
    expect(textLimitWarnings(events)).toEqual([
      expect.objectContaining({
        warning: expect.objectContaining({ code: 'runner_call_text_limit' }),
      }),
    ]);
  });
});

describe('Claude stream tool lifecycle', () => {
  it('keeps a tool open through its whole input and closes it on its tool_result', async () => {
    const events: RunnerCallEvent[] = [];
    const toolStages = () =>
      events
        .flatMap((event) =>
          projectRunnerCallEvents(event, { rootDir: '/project', phase: 'planning', sequence: 0 }),
        )
        .flatMap((event) => (event.type === 'runner_call_activity' ? [event.stage] : []));

    await invokeReply(
      [
        streamEvent({
          type: 'content_block_start',
          index: 1,
          content_block: { type: 'tool_use', id: 'toolu_1', name: 'Read', input: {} },
        }),
        JSON.stringify({
          type: 'assistant',
          message: {
            content: [
              { type: 'tool_use', id: 'toolu_1', name: 'Read', input: { file_path: 'src/a.ts' } },
            ],
          },
        }),
        JSON.stringify({
          type: 'user',
          message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'text' }] },
        }),
        JSON.stringify({ type: 'result', result: 'done' }),
      ],
      {
        onOutput: () => {},
        onCallEvent: (event) => {
          if (event.type === 'call_tool_use_done') {
            expect(events.some((previous) => previous.type === 'call_tool_use_done')).toBe(false);
            expect(toolStages().every((stage) => stage === 'started' || stage === 'updated')).toBe(
              true,
            );
          }
          events.push(event);
        },
      },
    );
    expect(events.filter((event) => event.type === 'call_tool_use_done')).toEqual([
      expect.objectContaining({
        toolUse: { id: 'toolu_1', name: 'Read', input: { file_path: 'src/a.ts' } },
      }),
    ]);
    expect(toolStages().at(-1)).toBe('completed');
  });
});
