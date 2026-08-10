import { realpathSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import type { CliExecutableIdentity } from '../../core/discovery/detection.js';
import type { RunnerCallContext, RunnerCallEvent } from '../calls/types.js';
import { claudeCodeImplementerAdapter } from './cli-tools/claude-code.js';
import type { CliInvocation } from './cli-tools/contract.js';
import { invokeCliAdapter } from './invoke-cli-adapter.js';

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

const EMIT_ALL = `const lines=JSON.parse(Buffer.from(process.argv[1],'base64').toString('utf8'));for(const line of lines)process.stdout.write(line+'\\n');`;
const EMIT_SLOWLY = `const lines=JSON.parse(Buffer.from(process.argv[1],'base64').toString('utf8'));let i=0;const tick=()=>{if(i>=lines.length)return;process.stdout.write(lines[i++]+'\\n');setTimeout(tick,40);};tick();`;

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

async function run(opts: {
  script: string;
  lines: readonly string[];
  idle?: { warnMs: number; killMs: number };
}) {
  const output: string[] = [];
  const events: RunnerCallEvent[] = [];
  const result = await invokeCliAdapter({
    adapter: claudeCodeImplementerAdapter,
    invocation: invocation({ script: opts.script, lines: opts.lines }),
    prompt: '',
    callContext,
    onOutput: (text) => output.push(text),
    onCallEvent: (event) => events.push(event),
    ...(opts.idle !== undefined && { idle: opts.idle }),
  });
  return { result, output, events };
}

function occurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

describe('invokeCliAdapter streaming a Claude Code capture', () => {
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

  itUnix('stays live while the runner emits only session-bearing thinking frames', async () => {
    const silent = Array.from({ length: 12 }, (_, index) => thinkingDelta(`step ${index}`));
    const { result, events } = await run({
      script: EMIT_SLOWLY,
      lines: [...silent, JSON.stringify({ type: 'result', session_id: SESSION_ID, result: 'ok' })],
      idle: { warnMs: 150, killMs: 20_000 },
    });

    expect(result).toMatchObject({ status: 'completed', nativeSessionId: SESSION_ID });
    expect(events.filter((event) => event.type === 'call_stalled')).toEqual([]);
  });

  itUnix('warns then times out a runner that produces no output at all', async () => {
    const { result, events } = await run({
      script: 'setInterval(() => {}, 1000);',
      lines: [],
      idle: { warnMs: 100, killMs: 400 },
    });

    expect(result).toMatchObject({ status: 'timeout', error: { code: 'timeout' } });
    expect(events.filter((event) => event.type === 'call_stalled')).toHaveLength(1);
  });
});
