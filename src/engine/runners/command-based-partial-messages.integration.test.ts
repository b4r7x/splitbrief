import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { RunnerCallEvent } from '../calls/types.js';
import { invokeCommandRunner } from './command-based.js';
import { requestTyped } from './typed-output.js';

/** `claude -p --output-format stream-json --verbose --include-partial-messages`, from `message_start` to `result`. */
const LIVE_CAPTURE = readFileSync(
  join(import.meta.dirname, '../../../testing/fixtures/claude-code/partial-messages.jsonl'),
  'utf8',
);

const SESSION = 'c3d312ab-5629-4ee2-aadd-d8da74b13c91';
type Frame = Record<string, unknown>;

function streamEvent(event: Frame, parent: string | null = null): Frame {
  return { type: 'stream_event', event, session_id: SESSION, parent_tool_use_id: parent };
}

function assistant(content: Frame[], parent: string | null = null): Frame {
  return {
    type: 'assistant',
    message: { role: 'assistant', content },
    parent_tool_use_id: parent,
    session_id: SESSION,
  };
}

function textDeltas(pieces: string[], parent: string | null = null): Frame[] {
  return pieces.map((text) =>
    streamEvent(
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } },
      parent,
    ),
  );
}

/** One message in the shape `--include-partial-messages` prints: its deltas, then its whole record. */
function partialMessage(pieces: string[], parent: string | null = null): Frame[] {
  return [
    streamEvent({ type: 'message_start', message: { role: 'assistant', content: [] } }, parent),
    streamEvent(
      { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
      parent,
    ),
    ...textDeltas(pieces, parent),
    assistant([{ type: 'text', text: pieces.join('') }], parent),
    streamEvent({ type: 'content_block_stop', index: 0 }, parent),
  ];
}

function toolUse(id: string, name: string): Frame[] {
  return [
    streamEvent({
      type: 'content_block_start',
      index: 1,
      content_block: { type: 'tool_use', id, name, input: {} },
    }),
    assistant([{ type: 'tool_use', id, name, input: {} }]),
  ];
}

function toolResult(id: string): Frame {
  return {
    type: 'user',
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: 'ok' }] },
    parent_tool_use_id: null,
    session_id: SESSION,
  };
}

function result(text: string): Frame {
  return { type: 'result', subtype: 'success', is_error: false, result: text, session_id: SESSION };
}

function lines(frames: Frame[]): string {
  return frames.map((frame) => `${JSON.stringify(frame)}\n`).join('');
}

/** A stream-json seat that reads its prompt, prints `stdout` and exits. */
async function invokeSeat(stdout: string, env: NodeJS.ProcessEnv = process.env) {
  const output: string[] = [];
  const events: RunnerCallEvent[] = [];
  const call = await invokeCommandRunner({
    source: {
      kind: 'config',
      runner: {
        command: process.execPath,
        args: [
          '-e',
          'process.stdin.resume(); process.stdin.on("end", () => process.stdout.write(process.argv[1]));',
          stdout,
        ],
        outputFormat: 'stream-json',
      },
      env,
      notFoundMessage: 'node not found',
    },
    prompt: 'Answer.',
    cwd: process.cwd(),
    callContext: { callId: 'call-partial', role: 'review', backendKind: 'shell' },
    onOutput: (chunk) => output.push(chunk),
    onCallEvent: (event) => events.push(event),
  });
  return { call, output: output.join(''), events };
}

describe('a stream-json shell seat that prints partial messages', () => {
  it('returns the live Claude Code reply once', async () => {
    const { call, output } = await invokeSeat(LIVE_CAPTURE);

    expect(call.status).toBe('completed');
    expect(call.text).toBe('HELLO WORLD');
    expect(output).toBe('HELLO WORLD');
  });

  it('returns each of two messages around a tool use once', async () => {
    const { call, output } = await invokeSeat(
      lines([
        ...partialMessage(['FIR', 'ST.']),
        ...toolUse('toolu_read', 'Read'),
        toolResult('toolu_read'),
        ...partialMessage(['SEC', 'OND.']),
        result('SECOND.'),
      ]),
    );

    expect(call.text).toBe('FIRST.SECOND.');
    expect(output).toBe('FIRST.SECOND.');
  });

  it('accepts a bare JSON typed answer on the first seat call', async () => {
    let seatCalls = 0;
    const typed = await requestTyped({
      schema: z.object({ verdict: z.string() }),
      jsonSchema: {
        type: 'object',
        properties: { verdict: { type: 'string' } },
        required: ['verdict'],
      },
      schemaName: 'verdict',
      prompt: 'Review the change.',
      call: {
        seat: 'reviewer',
        typedOutput: 'fallback',
        canResume: false,
        invoke: async () => {
          seatCalls += 1;
          const { call } = await invokeSeat(
            lines([...partialMessage(['{"verdict":', '"pass"}']), result('{"verdict":"pass"}')]),
          );
          return call;
        },
      },
    });

    expect('value' in typed ? typed.value : typed.error.data.errors).toEqual({ verdict: 'pass' });
    expect(seatCalls).toBe(1);
  });

  it('redacts a credential split across two deltas once', async () => {
    const secret = 'partial-secret-0123456789';
    const { call, output } = await invokeSeat(
      lines([
        ...partialMessage([`token ${secret.slice(0, 12)}`, `${secret.slice(12)} end`]),
        result(`token ${secret} end`),
      ]),
      { ...process.env, SEAT_API_KEY: secret },
    );

    expect(call.text).toBe('token ***REDACTED*** end');
    expect(output).toBe('token ***REDACTED*** end');
  });

  it('keeps the text of whole records that no delta streamed', async () => {
    const { call } = await invokeSeat(
      lines([
        assistant([{ type: 'text', text: 'FIRST.' }]),
        assistant([{ type: 'text', text: 'SECOND.' }]),
        result('SECOND.'),
      ]),
    );

    expect(call.text).toBe('FIRST.SECOND.');
  });

  it('closes the open block at a record with only a tool use', async () => {
    const { call } = await invokeSeat(
      lines([
        streamEvent({ type: 'message_start', message: { role: 'assistant', content: [] } }),
        ...textDeltas(['Do', 'ne.']),
        ...toolUse('toolu_read', 'Read'),
        toolResult('toolu_read'),
        assistant([{ type: 'text', text: 'Done.' }]),
        result('Done.'),
      ]),
    );

    expect(call.text).toBe('Done.Done.');
  });

  it('keeps the blocks of two subagents apart from each other and from the main loop', async () => {
    const { call, output } = await invokeSeat(
      lines([
        ...partialMessage(['Deleg', 'ating.']),
        ...toolUse('toolu_a', 'Task'),
        ...toolUse('toolu_b', 'Task'),
        ...textDeltas(['A says ', 'hi.'], 'toolu_a'),
        ...textDeltas(['B says ', 'hi.'], 'toolu_b'),
        assistant([{ type: 'text', text: 'A says hi.' }], 'toolu_a'),
        assistant([{ type: 'text', text: 'B says hi.' }], 'toolu_b'),
        toolResult('toolu_a'),
        toolResult('toolu_b'),
        ...partialMessage(['ANS', 'WER.']),
        result('ANSWER.'),
      ]),
    );

    expect(call.text).toBe('Delegating.ANSWER.');
    expect(output).toBe('Delegating.A says hi.B says hi.ANSWER.');
  });

  it('redacts a credential that one subagent splits across two deltas while another subagent streams between them', async () => {
    const secret = 'partial-secret-0123456789';
    const { call, output } = await invokeSeat(
      lines([
        ...partialMessage(['Deleg', 'ating.']),
        ...toolUse('toolu_a', 'Task'),
        ...toolUse('toolu_b', 'Task'),
        ...textDeltas([`token ${secret.slice(0, 12)}`], 'toolu_a'),
        ...textDeltas(['B says ', 'hi.'], 'toolu_b'),
        ...textDeltas([`${secret.slice(12)} end`], 'toolu_a'),
        assistant([{ type: 'text', text: `token ${secret} end` }], 'toolu_a'),
        assistant([{ type: 'text', text: 'B says hi.' }], 'toolu_b'),
        toolResult('toolu_a'),
        toolResult('toolu_b'),
        ...partialMessage(['ANS', 'WER.']),
        result('ANSWER.'),
      ]),
      { ...process.env, SEAT_API_KEY: secret },
    );

    expect(output).toContain('***REDACTED*** end');
    expect(output).not.toContain('partial-secr');
    expect(output).not.toContain('0123456789');
    expect(call.text).toBe('Delegating.ANSWER.');
  });

  it('prints the held end of a subagent text where the subagent ends, before the main answer', async () => {
    const { call, output } = await invokeSeat(
      lines([
        ...toolUse('toolu_a', 'Task'),
        ...partialMessage(['A ran ', 'tests'], 'toolu_a'),
        toolResult('toolu_a'),
        ...partialMessage(['ANS', 'WER.']),
        result('ANSWER.'),
      ]),
      { ...process.env, SEAT_API_KEY: 'sk-test-0123456789abcdef' },
    );

    expect(output).toMatch(/^A ran test[\s\S]+ANSWER\.$/);
    expect(call.text).toBe('ANSWER.');
  });

  it('records the held end of an open subagent text before an error result fails the call', async () => {
    const secret = 'partial-secret-0123456789';
    const { call, events } = await invokeSeat(
      lines([
        ...toolUse('toolu_a', 'Task'),
        ...partialMessage(['A says ', `token ${secret.slice(0, 12)}`], 'toolu_a'),
        { type: 'result', subtype: 'error_during_execution', is_error: true, session_id: SESSION },
      ]),
      { ...process.env, SEAT_API_KEY: secret },
    );
    const subagentText = events
      .flatMap((event) =>
        event.type === 'call_text_delta' && event.subagentId === 'toolu_a' ? [event.text] : [],
      )
      .join('');

    expect(call.status).toBe('failed');
    expect(subagentText).toBe('A says token ***REDACTED***');
  });

  it('prints the held end of a subagent text when the stream stops with no result', async () => {
    const secret = 'partial-secret-0123456789';
    const { output } = await invokeSeat(
      lines([
        ...toolUse('toolu_a', 'Task'),
        ...partialMessage(['A says ', `token ${secret.slice(0, 12)}`], 'toolu_a'),
      ]),
      { ...process.env, SEAT_API_KEY: secret },
    );

    expect(output).toBe('A says token ***REDACTED***');
  });
});
