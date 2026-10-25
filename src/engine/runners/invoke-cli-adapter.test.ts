import { realpathSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import type { CliExecutableIdentity } from '../../core/discovery/detection.js';
import { projectRunnerCallEvents } from '../calls/event-projection.js';
import { createRunnerCallRecorder } from '../calls/recorder.js';
import type { RunnerCallContext, RunnerCallEvent } from '../calls/types.js';
import { claudeCodeImplementerAdapter, claudeCodePlannerAdapter } from './cli-tools/claude-code.js';
import type { CliInvocation, CliProtocolEvent } from './cli-tools/contract.js';
import { recordCliProtocolEvent } from './cli-tools/process-invoke.js';
import { createCliTextForwarder, invokeCliAdapter } from './invoke-cli-adapter.js';

const itUnix = process.platform === 'win32' ? it.skip : it;

const SESSION_ID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

const callContext = {
  callId: 'invoke-cli-adapter-test',
  role: 'implementer',
  backendKind: 'cli',
  runnerName: 'claude',
} satisfies RunnerCallContext;

function executableIdentity(): CliExecutableIdentity {
  const path = realpathSync(process.execPath);
  const info = statSync(path);
  return {
    path,
    fingerprint: { dev: info.dev, ino: info.ino, size: info.size, mtimeMs: info.mtimeMs },
  };
}

function invocation(opts: { script: string; lines: readonly string[] }): CliInvocation {
  return {
    executable: executableIdentity(),
    args: ['-e', opts.script, Buffer.from(JSON.stringify(opts.lines), 'utf8').toString('base64')],
    promptTransport: { kind: 'stdin' },
    environment: {},
    cwd: tmpdir(),
    timeoutMs: 20_000,
    signal: undefined,
  };
}

/**
 * The watchdog is armed at spawn, so the first silence it measures is the
 * child's own startup — high hundreds of milliseconds under fork contention,
 * with no fixed ceiling — not the fixture's inter-frame gap, which stayed under
 * 50 ms in every sample. The stream is sized from the bound so it always
 * outlives it: a watchdog that stopped counting stdout as liveness still has a
 * window to warn.
 */
const IDLE_WARN_MS = 1_000;
const FRAME_INTERVAL_MS = 40;
const SILENT_FRAME_COUNT = Math.ceil((IDLE_WARN_MS * 1.5) / FRAME_INTERVAL_MS);

const EMIT_ALL = `const lines=JSON.parse(Buffer.from(process.argv[1],'base64').toString('utf8'));for(const line of lines)process.stdout.write(line+'\\n');`;
const EMIT_SLOWLY = `const lines=JSON.parse(Buffer.from(process.argv[1],'base64').toString('utf8'));let i=0;const tick=()=>{if(i>=lines.length)return;process.stdout.write(lines[i++]+'\\n');setTimeout(tick,${FRAME_INTERVAL_MS});};tick();`;

function streamEvent(event: Record<string, unknown>): string {
  return JSON.stringify({ type: 'stream_event', session_id: SESSION_ID, event });
}

function textDelta(text: string): string {
  return streamEvent({ type: 'content_block_delta', delta: { type: 'text_delta', text } });
}

function thinkingDelta(text: string): string {
  return streamEvent({
    type: 'content_block_delta',
    delta: { type: 'thinking_delta', thinking: text },
  });
}

/** The line shapes of a real `claude -p --include-partial-messages` capture. */
function claudeCapture(deltas: readonly string[]): readonly string[] {
  const message = deltas.join('');
  return [
    JSON.stringify({ type: 'system', subtype: 'init', session_id: SESSION_ID }),
    streamEvent({ type: 'message_start' }),
    streamEvent({ type: 'content_block_start', content_block: { type: 'text', text: '' } }),
    ...deltas.map(textDelta),
    JSON.stringify({
      type: 'assistant',
      session_id: SESSION_ID,
      message: { content: [{ type: 'text', text: message }] },
    }),
    streamEvent({ type: 'content_block_stop' }),
    streamEvent({ type: 'message_delta', usage: { input_tokens: 4, output_tokens: 2 } }),
    streamEvent({ type: 'message_stop' }),
    JSON.stringify({ type: 'rate_limit_event', session_id: SESSION_ID }),
    JSON.stringify({ type: 'result', session_id: SESSION_ID, result: message }),
  ];
}

function systemFrame(subtype: string, fields: Record<string, unknown> = {}): string {
  return JSON.stringify({ type: 'system', subtype, session_id: SESSION_ID, ...fields });
}

/** A turn wrapped in the frames Claude Code prints for its own bookkeeping, and one retry. */
function claudeCaptureWithSystemFrames(deltas: readonly string[]): readonly string[] {
  const message = deltas.join('');
  return [
    systemFrame('hook_started', { hook_id: 'hook-1', hook_name: 'SessionStart:startup' }),
    systemFrame('hook_response', { hook_id: 'hook-1', outcome: 'success', exit_code: 0 }),
    systemFrame('init'),
    systemFrame('status', { status: 'requesting' }),
    systemFrame('api_retry', {
      attempt: 1,
      max_retries: 10,
      retry_delay_ms: 2100,
      error_status: 529,
      error: 'overloaded',
    }),
    systemFrame('thinking_tokens', { estimated_tokens: 40, estimated_tokens_delta: 40 }),
    systemFrame('thinking_tokens', { estimated_tokens: 80, estimated_tokens_delta: 40 }),
    streamEvent({ type: 'message_start' }),
    ...deltas.map(textDelta),
    JSON.stringify({
      type: 'assistant',
      session_id: SESSION_ID,
      message: { content: [{ type: 'text', text: message }] },
    }),
    streamEvent({ type: 'message_stop' }),
    systemFrame('task_started', { task_id: 'task-1', description: 'Survey the readers' }),
    systemFrame('task_notification', { task_id: 'task-1', status: 'completed', summary: 'done' }),
    JSON.stringify({ type: 'result', session_id: SESSION_ID, result: message }),
  ];
}

async function run(opts: {
  script: string;
  lines: readonly string[];
  idle?: { warnMs: number; killMs: number };
}) {
  const output: string[] = [];
  const messageStarts: boolean[] = [];
  const events: RunnerCallEvent[] = [];
  const result = await invokeCliAdapter({
    adapter: claudeCodeImplementerAdapter,
    invocation: invocation({ script: opts.script, lines: opts.lines }),
    prompt: '',
    callContext,
    onOutput: (text, opts) => {
      output.push(text);
      messageStarts.push(opts?.messageStart === true);
    },
    onCallEvent: (event) => events.push(event),
    ...(opts.idle !== undefined && { idle: opts.idle }),
  });
  return { result, output, messageStarts, events };
}

function occurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

const RATE_LIMIT_RESETS_AT = 1_794_000_000;

function rateLimitFrame(opts: {
  status: 'allowed' | 'allowed_warning' | 'rejected';
  rateLimitType?: string | undefined;
  overageStatus?: string | undefined;
  utilization?: number | undefined;
  resetsAt?: number | undefined;
}): string {
  const windowKey =
    opts.rateLimitType === 'five_hour' || opts.rateLimitType === 'seven_day'
      ? opts.rateLimitType
      : 'seven_day';
  const utilization = opts.utilization ?? (opts.status === 'allowed' ? 0.56 : 0.8);
  const resetsAt = opts.resetsAt ?? RATE_LIMIT_RESETS_AT;
  return JSON.stringify({
    type: 'rate_limit_event',
    session_id: SESSION_ID,
    rate_limit_info: {
      status: opts.status,
      rateLimitType: opts.rateLimitType ?? windowKey,
      resetsAt,
      ...(opts.overageStatus !== undefined && { overageStatus: opts.overageStatus }),
      unifiedWindows: {
        [windowKey]: {
          utilization,
          resetsAt,
        },
      },
    },
  });
}

function activityRows(events: readonly RunnerCallEvent[]) {
  return events
    .flatMap((event) =>
      projectRunnerCallEvents(event, { rootDir: '/project', phase: 'implementing', sequence: 0 }),
    )
    .flatMap((event) => (event.type === 'runner_call_activity' ? [event] : []));
}

function warningRows(events: readonly RunnerCallEvent[]) {
  return events.flatMap((event) => (event.type === 'call_warning' ? [event.warning] : []));
}

function terminalRows(events: readonly RunnerCallEvent[]): RunnerCallEvent[] {
  return events.filter((event) => event.type === 'call_completed' || event.type === 'call_error');
}

describe('synchronous CLI frame consumers', () => {
  it('reconciles interleaved subagent restatements apart from the main answer and system text', () => {
    const output: { text: string; messageStart: boolean }[] = [];
    const sourceEvents: RunnerCallEvent[] = [];
    const forwardText = createCliTextForwarder((text, opts, event) => {
      output.push({ text, messageStart: opts?.messageStart === true });
      sourceEvents.push(event);
    });
    const recorder = createRunnerCallRecorder({
      context: callContext,
      onEvent: (event) => {
        if (event.type === 'call_text_delta') forwardText(event);
      },
    });
    const protocol: readonly CliProtocolEvent[] = [
      { type: 'text', channel: 'assistant', text: 'Main ', semantics: 'delta' },
      {
        type: 'text',
        channel: 'assistant',
        subagentId: 'agent-1',
        text: 'subagent answer',
        semantics: 'delta',
      },
      {
        type: 'text',
        channel: 'assistant',
        subagentId: 'agent-2',
        text: 'subagent answer',
        semantics: 'delta',
      },
      { type: 'text', channel: 'system', text: 'System activity.' },
      {
        type: 'text',
        channel: 'assistant',
        subagentId: 'agent-1',
        text: 'subagent answer',
        semantics: 'final',
      },
      {
        type: 'text',
        channel: 'assistant',
        subagentId: 'agent-2',
        text: 'subagent answer extended',
        semantics: 'final',
      },
      { type: 'text', channel: 'assistant', text: 'Main answer.', semantics: 'final' },
      { type: 'text', channel: 'assistant', text: 'Next.', semantics: 'final' },
      { type: 'text', channel: 'result', text: 'Main answer.Next.', semantics: 'final' },
    ];
    for (const event of protocol) recordCliProtocolEvent(recorder, event);
    expect(output).toEqual([
      { text: 'Main ', messageStart: false },
      { text: 'subagent answer', messageStart: false },
      { text: 'subagent answer', messageStart: false },
      { text: 'System activity.', messageStart: false },
      { text: ' extended', messageStart: false },
      { text: 'answer.', messageStart: false },
      { text: 'Next.', messageStart: true },
    ]);
    expect(sourceEvents).toMatchObject([
      { channel: 'assistant', text: 'Main ', semantics: 'delta' },
      { subagentId: 'agent-1', text: 'subagent answer', semantics: 'delta' },
      { subagentId: 'agent-2', text: 'subagent answer', semantics: 'delta' },
      { channel: 'system', text: 'System activity.' },
      { subagentId: 'agent-2', text: 'subagent answer extended', semantics: 'final' },
      { channel: 'assistant', text: 'Main answer.', semantics: 'final' },
      { channel: 'assistant', text: 'Next.', semantics: 'final' },
    ]);
    expect(recorder.snapshot().text).toBe('Main answer.Next.');
  });

  itUnix('produces the same Claude text, activity and usage as a process call', async () => {
    const lines = claudeCaptureWithSystemFrames(['Reading ', 'the parser.']);
    const output: string[] = [];
    const messageStarts: boolean[] = [];
    const events: RunnerCallEvent[] = [];
    const forwardText = createCliTextForwarder((text, opts) => {
      output.push(text);
      messageStarts.push(opts?.messageStart === true);
    });
    const recorder = createRunnerCallRecorder({
      context: callContext,
      onEvent: (event) => {
        events.push(event);
        if (event.type === 'call_text_delta') forwardText(event);
      },
    });
    const parse = claudeCodePlannerAdapter.createParser?.() ?? claudeCodePlannerAdapter.parse;
    for (const line of lines) {
      for (const event of parse(line)) recordCliProtocolEvent(recorder, event);
    }
    const processCall = await run({ script: EMIT_ALL, lines });

    expect(output).toEqual(['Reading ', 'the parser.']);
    expect(processCall.output).toEqual(output);
    expect(processCall.messageStarts).toEqual(messageStarts);
    expect(recorder.snapshot()).toMatchObject({
      text: processCall.result.text,
      usage: processCall.result.usage,
      nativeSessionId: SESSION_ID,
    });
    const activity = (events: readonly RunnerCallEvent[]) =>
      activityRows(events).map(({ kind, label, diagnosticPartial }) => ({
        kind,
        label,
        diagnosticPartial,
      }));
    expect(activity(events)).toEqual(activity(processCall.events));
    expect(events.some((event) => event.type === 'call_heartbeat')).toBe(true);
  });

  it('reconciles final text and preserves assistant boundaries around other channels', () => {
    const output: { text: string; messageStart: boolean }[] = [];
    const forwardText = createCliTextForwarder((text, opts) => {
      output.push({ text, messageStart: opts?.messageStart === true });
    });
    const recorder = createRunnerCallRecorder({
      context: callContext,
      onEvent: (event) => {
        if (event.type === 'call_text_delta') forwardText(event);
      },
    });
    const protocol: readonly CliProtocolEvent[] = [
      { type: 'text', channel: 'assistant', text: 'Read', semantics: 'delta' },
      { type: 'text', channel: 'assistant', text: 'Reading.', semantics: 'final' },
      { type: 'text', channel: 'system', text: 'Subagent.' },
      { type: 'text', channel: 'assistant', text: '', semantics: 'delta' },
      { type: 'text', channel: 'assistant', text: 'Done.', semantics: 'final' },
      { type: 'text', channel: 'result', text: 'Reading.\n\nDone.', semantics: 'final' },
      { type: 'text', channel: 'result', text: 'Reading.\n\nDone.\nOK', semantics: 'final' },
    ];
    for (const event of protocol) recordCliProtocolEvent(recorder, event);

    expect(output).toEqual([
      { text: 'Read', messageStart: false },
      { text: 'ing.', messageStart: false },
      { text: 'Subagent.', messageStart: false },
      { text: 'Done.', messageStart: true },
      { text: 'Reading.\n\nDone.\nOK', messageStart: false },
    ]);
    expect(recorder.snapshot().text).toBe('Reading.\n\nDone.\nOK');
  });
});

describe('invokeCliAdapter streaming a Claude Code capture', () => {
  itUnix(
    'publishes reconciled subagent records without changing main message boundaries',
    async () => {
      const subagent = (id: string, event: Record<string, unknown>) =>
        JSON.stringify({ ...event, parent_tool_use_id: id });
      const assistant = (text: string) => ({
        type: 'assistant',
        message: { content: [{ type: 'text', text }] },
      });
      const delta = {
        type: 'stream_event',
        event: {
          type: 'content_block_delta',
          delta: { type: 'text_delta', text: 'subagent answer' },
        },
      };
      const { result, output, messageStarts, events } = await run({
        script: EMIT_ALL,
        lines: [
          streamEvent({ type: 'message_start' }),
          textDelta('Main '),
          subagent('agent-1', { type: 'stream_event', event: { type: 'message_start' } }),
          subagent('agent-1', delta),
          subagent('agent-2', delta),
          subagent('agent-1', assistant('subagent answer')),
          subagent('agent-2', assistant('subagent answer')),
          JSON.stringify(assistant('Main answer.')),
          subagent('agent-1', assistant('subagent answer')),
          streamEvent({ type: 'message_start' }),
          JSON.stringify(assistant('Next.')),
          JSON.stringify({ type: 'result', result: '' }),
        ],
      });
      expect(result.text).toBe('Next.');
      expect(output).toEqual([
        'Main ',
        'subagent answer',
        'subagent answer',
        'answer.',
        'subagent answer',
        'Next.',
      ]);
      expect(messageStarts).toEqual([false, false, false, false, true, true]);
      const subagentEvents = events.filter(
        (event) => event.type === 'call_text_delta' && event.subagentId !== undefined,
      );
      expect(subagentEvents).toEqual([
        expect.objectContaining({
          subagentId: 'agent-1',
          channel: 'assistant',
          text: 'subagent answer',
          semantics: 'delta',
        }),
        expect.objectContaining({
          subagentId: 'agent-2',
          channel: 'assistant',
          text: 'subagent answer',
          semantics: 'delta',
        }),
        expect.objectContaining({
          subagentId: 'agent-1',
          channel: 'assistant',
          text: 'subagent answer',
          semantics: 'delta',
        }),
      ]);
      expect(activityRows(events).some((event) => event.label === 'system activity')).toBe(false);
    },
  );

  itUnix(
    'marks the next assistant message after a final snapshot without repeating deltas',
    async () => {
      const first = ['Read', 'ing done.'];
      const second = ['I edit ', 'the file.'];
      const assistant = (text: string) =>
        JSON.stringify({
          type: 'assistant',
          session_id: SESSION_ID,
          message: { content: [{ type: 'text', text }] },
        });
      const { result, output, messageStarts } = await run({
        script: EMIT_ALL,
        lines: [
          streamEvent({ type: 'message_start' }),
          ...first.map(textDelta),
          assistant(first.join('')),
          streamEvent({ type: 'message_stop' }),
          streamEvent({ type: 'message_start' }),
          ...second.map(textDelta),
          assistant(second.join('')),
          JSON.stringify({ type: 'result', session_id: SESSION_ID, result: second.join('') }),
        ],
      });

      expect(result.text).toBe(second.join(''));
      expect(output).toEqual([...first, ...second]);
      expect(messageStarts).toEqual([false, false, true, false]);
    },
  );

  itUnix('keeps a boundary after an empty final snapshot and empty chunks', async () => {
    const assistant = (content: unknown[]) =>
      JSON.stringify({
        type: 'assistant',
        session_id: SESSION_ID,
        message: { content },
      });
    for (const emptyContent of [[{ type: 'text', text: '' }], []]) {
      const { output, messageStarts } = await run({
        script: EMIT_ALL,
        lines: [
          streamEvent({ type: 'message_start' }),
          textDelta('First.'),
          textDelta(''),
          assistant(emptyContent),
          streamEvent({ type: 'message_stop' }),
          streamEvent({ type: 'message_start' }),
          textDelta('Second.'),
          assistant([{ type: 'text', text: 'Second.' }]),
          JSON.stringify({ type: 'result', session_id: SESSION_ID, result: 'Second.' }),
        ],
      });

      expect(output).toEqual(['First.', 'Second.']);
      expect(messageStarts).toEqual([false, true]);
    }
  });

  itUnix('retains streamed text if an empty final snapshot ends in failure', async () => {
    const { result, output } = await run({
      script: EMIT_ALL,
      lines: [
        streamEvent({ type: 'message_start' }),
        textDelta('First.'),
        JSON.stringify({
          type: 'assistant',
          session_id: SESSION_ID,
          message: { content: [] },
        }),
        JSON.stringify({ type: 'result', session_id: SESSION_ID, is_error: true, result: '' }),
      ],
    });

    expect(result.status).toBe('failed');
    expect(result.text).toBe('First.');
    expect(output).toEqual(['First.']);
  });

  itUnix('streams the message once and captures the session id once', async () => {
    const deltas = ['returning `a', ' - b`', '\n\n', 'second para.'];
    const message = deltas.join('');
    const { result, output, events } = await run({
      script: EMIT_ALL,
      lines: claudeCapture(deltas),
    });

    expect(result).toMatchObject({ status: 'completed', nativeSessionId: SESSION_ID });
    expect(result.text).toBe(message);
    expect(occurrences(output.join(''), message)).toBe(1);
    expect(events.filter((event) => event.type === 'call_session_id')).toEqual([
      expect.objectContaining({ type: 'call_session_id', nativeSessionId: SESSION_ID }),
    ]);
  });

  itUnix('streams the model text and none of the frames Claude Code keeps for itself', async () => {
    const deltas = ["I'll start with orientation: ", 'the fixture and its readers.'];
    const { result, output } = await run({
      script: EMIT_ALL,
      lines: claudeCaptureWithSystemFrames(deltas),
    });

    expect(result).toMatchObject({ status: 'completed', text: deltas.join('') });
    expect(output.join('')).toBe(deltas.join(''));
  });

  itUnix('shows a retry as a warning and the bookkeeping frames as no activity', async () => {
    const { events } = await run({
      script: EMIT_ALL,
      lines: claudeCaptureWithSystemFrames(['Done.']),
    });
    const activity = events
      .flatMap((event) =>
        projectRunnerCallEvents(event, { rootDir: '/project', phase: 'implementing', sequence: 0 }),
      )
      .flatMap((event) => (event.type === 'runner_call_activity' ? [event] : []));

    expect(activity.map((event) => event.label)).not.toContain('system activity');
    expect(activity).toContainEqual(
      expect.objectContaining({
        kind: 'warning',
        label: 'warning',
        diagnosticPartial: 'overloaded (HTTP 529): retry 1 of 10 in 2.1s',
      }),
    );
  });

  itUnix('keeps the call fresh on its bookkeeping frames', async () => {
    const { events } = await run({
      script: EMIT_ALL,
      lines: claudeCaptureWithSystemFrames(['Done.']),
    });
    const heartbeats = events.filter((event) => event.type === 'call_heartbeat');
    const projected = heartbeats.flatMap((event) =>
      projectRunnerCallEvents(event, { rootDir: '/project', phase: 'implementing', sequence: 0 }),
    );

    expect(heartbeats.length).toBeGreaterThan(0);
    expect(new Set(projected.map((event) => event.type))).toEqual(
      new Set(['runner_call_heartbeat']),
    );
  });

  itUnix('streams every assistant message when the runner sends no partial deltas', async () => {
    const messages = ['one ', 'two ', 'three'];
    const { result, output } = await run({
      script: EMIT_ALL,
      lines: [
        ...messages.map((text) =>
          JSON.stringify({
            type: 'assistant',
            session_id: SESSION_ID,
            message: { content: [{ type: 'text', text }] },
          }),
        ),
        JSON.stringify({ type: 'result', session_id: SESSION_ID, result: messages.at(-1) }),
      ],
    });

    expect(result).toMatchObject({ status: 'completed' });
    expect(output.join('')).toBe(messages.join(''));
  });

  itUnix(
    'reprints a final text that differs from the stream by more than line breaks',
    async () => {
      const messages = ['Reading a.ts.', 'VERDICT: widen a.ts — r'];
      const final = 'Reading a.ts.\n\nVERDICT: widen a.ts, b.ts — r';
      const { result, output } = await run({
        script: EMIT_ALL,
        lines: [
          ...messages.map((text) =>
            JSON.stringify({
              type: 'assistant',
              session_id: SESSION_ID,
              message: { content: [{ type: 'text', text }] },
            }),
          ),
          JSON.stringify({ type: 'result', session_id: SESSION_ID, result: final }),
        ],
      });

      expect(result).toMatchObject({ status: 'completed', text: final });
      expect(output.join('')).toBe(`${messages.join('')}${final}`);
    },
  );

  itUnix('stays live while the runner emits only session-bearing thinking frames', async () => {
    const silent = Array.from({ length: SILENT_FRAME_COUNT }, (_, index) =>
      thinkingDelta(`step ${index}`),
    );
    const started = Date.now();
    const { result, events } = await run({
      script: EMIT_SLOWLY,
      lines: [...silent, JSON.stringify({ type: 'result', session_id: SESSION_ID, result: 'ok' })],
      idle: { warnMs: IDLE_WARN_MS, killMs: 20_000 },
    });

    expect(result).toMatchObject({ status: 'completed', nativeSessionId: SESSION_ID });
    expect(Date.now() - started).toBeGreaterThan(IDLE_WARN_MS);
    expect(events.filter((event) => event.type === 'call_stalled')).toEqual([]);
  });

  itUnix('warns then cuts a runner that produces no output at all', async () => {
    const { result, events } = await run({
      script: 'setInterval(() => {}, 1000);',
      lines: [],
      idle: { warnMs: 100, killMs: 400 },
    });

    expect(result).toMatchObject({ status: 'failed', error: { code: 'no-progress-cut' } });
    expect(events.filter((event) => event.type === 'call_stalled')).toHaveLength(1);
  });

  itUnix('keeps an allowed rate-limit frame beside a rejected overage as telemetry', async () => {
    const { result, events } = await run({
      script: EMIT_ALL,
      lines: [
        rateLimitFrame({
          status: 'allowed',
          rateLimitType: 'seven_day',
          overageStatus: 'rejected',
        }),
        JSON.stringify({ type: 'result', session_id: SESSION_ID, result: 'ok' }),
      ],
    });
    const rateLimitActivities = activityRows(events).filter((event) =>
      event.label.includes('claude_rate_limit'),
    );

    expect(rateLimitActivities).toEqual([]);
    expect(events.filter((event) => event.type === 'call_heartbeat').length).toBeGreaterThan(0);
    expect(result).toMatchObject({ status: 'completed' });
    expect(terminalRows(events)).toHaveLength(1);
  });

  itUnix('carries the stepped rate-limit warning through to the activity', async () => {
    const { result, events } = await run({
      script: EMIT_ALL,
      lines: [
        rateLimitFrame({ status: 'allowed_warning', rateLimitType: 'seven_day', utilization: 0.8 }),
        rateLimitFrame({ status: 'rejected', rateLimitType: 'five_hour', utilization: 0.75 }),
        JSON.stringify({ type: 'result', session_id: SESSION_ID, result: 'ok' }),
      ],
    });
    const warnings = warningRows(events);
    const activity = activityRows(events);

    expect(warnings).toContainEqual(
      expect.objectContaining({
        code: 'claude_rate_limit',
        severity: 'warning',
        message: expect.stringContaining('80% of your Claude Code weekly limit'),
      }),
    );
    expect(warnings).toContainEqual(
      expect.objectContaining({
        code: 'claude_rate_limit',
        severity: 'warning',
        message: expect.stringContaining('75% of your Claude Code 5-hour limit'),
      }),
    );
    expect(activity).toContainEqual(
      expect.objectContaining({
        kind: 'warning',
        label: 'warning',
        diagnosticPartial: expect.stringContaining('80% of your Claude Code weekly limit'),
      }),
    );
    expect(activity).toContainEqual(
      expect.objectContaining({
        kind: 'warning',
        label: 'warning',
        diagnosticPartial: expect.stringContaining('75% of your Claude Code 5-hour limit'),
      }),
    );
    expect(result).toMatchObject({ status: 'completed' });
    expect(terminalRows(events)).toHaveLength(1);
  });

  itUnix('passes the usage field of a stepped rate-limit warning to its call warning', async () => {
    const { events } = await run({
      script: EMIT_ALL,
      lines: [
        rateLimitFrame({
          status: 'allowed_warning',
          rateLimitType: 'seven_day',
          utilization: 0.75,
        }),
        JSON.stringify({ type: 'result', session_id: SESSION_ID, result: 'ok' }),
      ],
    });

    expect(warningRows(events)).toContainEqual(
      expect.objectContaining({
        code: 'claude_rate_limit',
        usage: expect.objectContaining({ window: 'seven_day', step: 75 }),
        message: expect.stringContaining('75% of your Claude Code weekly limit'),
      }),
    );
  });

  itUnix('carries refusal and error-notification severity with an ordinary warning', async () => {
    const { result, events } = await run({
      script: EMIT_ALL,
      lines: [
        systemFrame('model_refusal_no_fallback', {
          original_model: 'claude-opus-5',
          api_refusal_category: 'bio',
          api_refusal_explanation: null,
          content: '',
        }),
        systemFrame('notification', {
          key: 'usage-limit',
          text: "You've hit your usage limit",
          priority: 'high',
          color: 'error',
        }),
        systemFrame('api_retry', {
          attempt: 1,
          max_retries: 10,
          retry_delay_ms: 2100,
          error_status: 529,
          error: 'overloaded',
        }),
        JSON.stringify({
          type: 'result',
          session_id: SESSION_ID,
          is_error: true,
          result: 'stopped',
        }),
      ],
    });
    const activity = activityRows(events);

    expect(activity).toContainEqual(
      expect.objectContaining({
        kind: 'error',
        label: 'error',
        diagnosticPartial: 'claude-opus-5 refused (bio): no fallback model',
      }),
    );
    expect(activity).toContainEqual(
      expect.objectContaining({
        kind: 'error',
        label: 'error',
        diagnosticPartial: "You've hit your usage limit",
      }),
    );
    expect(activity).toContainEqual(
      expect.objectContaining({
        kind: 'warning',
        label: 'warning',
        diagnosticPartial: 'overloaded (HTTP 529): retry 1 of 10 in 2.1s',
      }),
    );
    expect(result).toMatchObject({ status: 'failed' });
    const terminals = terminalRows(events);
    expect(terminals).toHaveLength(1);
    expect(terminals[0]).toMatchObject({ type: 'call_error' });
  });

  itUnix('carries fallback model ids through the warning and its activity row', async () => {
    const { result, events } = await run({
      script: EMIT_ALL,
      lines: [
        systemFrame('model_fallback', {
          trigger: 'overloaded',
          original_model: 'claude-opus-5-5',
          fallback_model: 'claude-sonnet-5',
          content: 'Opus 5.5 is overloaded · using Sonnet 5 for this turn',
        }),
        JSON.stringify({ type: 'result', session_id: SESSION_ID, result: 'ok' }),
      ],
    });

    expect(result).toMatchObject({ status: 'completed' });
    expect(warningRows(events)).toContainEqual(
      expect.objectContaining({
        code: 'claude_fallback',
        message: 'claude-opus-5-5 → claude-sonnet-5 (overloaded)',
        originalModel: 'claude-opus-5-5',
        fallbackModel: 'claude-sonnet-5',
      }),
    );
    expect(activityRows(events)).toContainEqual(
      expect.objectContaining({
        kind: 'warning',
        label: 'warning',
        diagnosticPartial: 'claude-opus-5-5 → claude-sonnet-5 (overloaded)',
        originalModel: 'claude-opus-5-5',
        fallbackModel: 'claude-sonnet-5',
      }),
    );
  });
});
