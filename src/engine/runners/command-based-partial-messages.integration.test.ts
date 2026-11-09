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

function toolUse(id: string, name: string, parent: string | null = null): Frame[] {
  return [
    streamEvent(
      {
        type: 'content_block_start',
        index: 1,
        content_block: { type: 'tool_use', id, name, input: {} },
      },
      parent,
    ),
    assistant([{ type: 'tool_use', id, name, input: {} }], parent),
  ];
}

function toolResult(id: string, parent: string | null = null): Frame {
  return {
    type: 'user',
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: 'ok' }] },
    parent_tool_use_id: parent,
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
async function invokeSeat(
  stdout: string,
  env: NodeJS.ProcessEnv = process.env,
  seat: { maxToolCalls?: number; keepRunning?: boolean } = {},
) {
  const output: string[] = [];
  const order: string[] = [];
  const events: RunnerCallEvent[] = [];
  const call = await invokeCommandRunner({
    source: {
      kind: 'config',
      runner: {
        command: process.execPath,
        args: [
          '-e',
          'process.stdin.resume(); process.stdin.on("end", () => { process.stdout.write(process.argv[1]); if (process.argv[2] === "keep") setInterval(() => undefined, 1000); });',
          stdout,
          seat.keepRunning === true ? 'keep' : 'exit',
        ],
        outputFormat: 'stream-json',
        maxToolCalls: seat.maxToolCalls,
      },
      env,
      notFoundMessage: 'node not found',
    },
    prompt: 'Answer.',
    cwd: process.cwd(),
    callContext: { callId: 'call-partial', role: 'review', backendKind: 'shell' },
    timeoutMs: seat.keepRunning === true ? 10_000 : undefined,
    onOutput: (chunk, marks) => {
      output.push(chunk);
      order.push(
        `text ${chunk}${marks?.continues === true ? ' +continues' : ''}${marks?.subagent === true ? ' +subagent' : ''}`,
      );
    },
    onCallEvent: (event) => {
      events.push(event);
      if (event.type === 'call_tool_use_done') order.push(`tool ${event.toolUse.name}`);
    },
  });
  return { call, output: output.join(''), order, events };
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

describe('a sub-agent speaks while the main text holds a key prefix', () => {
  const keyEnv = { ...process.env, SEAT_API_KEY: 'sk-test-0123456789abcdef' };

  it('prints the sub-agent text after the held end of the main word', async () => {
    const { output } = await invokeSeat(
      lines([
        ...partialMessage(['Checking ', 'tests']),
        ...toolUse('toolu_a', 'Task'),
        ...textDeltas(['Found 3.'], 'toolu_a'),
        toolResult('toolu_a'),
        ...partialMessage(['Done.']),
        result('Done.'),
      ]),
      keyEnv,
    );

    expect(output).toBe('Checking testsFound 3.Done.');
  });

  it('prints a held key prefix that is not a key before the sub-agent text', async () => {
    const { output } = await invokeSeat(
      lines([
        ...partialMessage(['Set the key to sk-']),
        ...toolUse('toolu_a', 'Task'),
        ...textDeltas(['Found 3.'], 'toolu_a'),
        toolResult('toolu_a'),
        ...partialMessage(['Done.']),
        result('Done.'),
      ]),
      keyEnv,
    );

    expect(output).toBe('Set the key to sk-Found 3.Done.');
  });

  it('prints the sub-agent text after the masked held end when the stream stops', async () => {
    const { output } = await invokeSeat(
      lines([
        ...partialMessage(['Checking ', 'tests']),
        ...toolUse('toolu_a', 'Task'),
        ...textDeltas(['Found 3.'], 'toolu_a'),
        toolResult('toolu_a'),
      ]),
      keyEnv,
    );

    expect(output).toBe('Checking test***REDACTED***Found 3.');
  });

  it('never prints a key that the sub-agent text splits in clear', async () => {
    const secret = 'split-stdout-canary-9274';
    const { call, output, events } = await invokeSeat(
      lines([
        ...textDeltas(['token split-stdo']),
        ...toolUse('toolu_a', 'Task'),
        ...textDeltas(['Found 3.'], 'toolu_a'),
        toolResult('toolu_a'),
        ...textDeltas(['ut-canary-9274 end']),
        result(`token ${secret} end`),
      ]),
      { ...process.env, SEAT_API_KEY: secret },
    );

    expect(output).toBe('token Found 3.***REDACTED*** end');
    expect(output).not.toContain('split-stdo');
    expect(output).not.toContain('ut-canary');
    expect(call.text).not.toContain('split-stdo');
    expect(call.text).not.toContain('ut-canary');
    expect(JSON.stringify(events)).not.toContain('split-stdo');
    expect(JSON.stringify(events)).not.toContain('ut-canary');
  });

  it('keeps the clear main text when the held end is not a key', async () => {
    const { call } = await invokeSeat(
      lines([
        ...partialMessage(['Checking ', 'tests']),
        ...toolUse('toolu_a', 'Task'),
        ...textDeltas(['Found 3.'], 'toolu_a'),
        toolResult('toolu_a'),
        ...partialMessage(['Done.']),
        result('Done.'),
      ]),
      keyEnv,
    );

    expect(call.text).toBe('Checking testsDone.');
  });

  it('shows the Task row before the held end and marks the sub-agent text', async () => {
    const { order } = await invokeSeat(
      lines([
        ...partialMessage(['Checking ', 'tests']),
        ...toolUse('toolu_a', 'Task'),
        ...textDeltas(['Found 3.'], 'toolu_a'),
        toolResult('toolu_a'),
        ...partialMessage(['Done.']),
        result('Done.'),
      ]),
      keyEnv,
    );

    expect(order).toEqual([
      'text Checking ',
      'text test',
      'tool Task',
      'text s +continues',
      'text Found 3. +subagent',
      'text Done.',
    ]);
  });
});

describe('a tool use while the main text holds a key prefix', () => {
  const keyEnv = { ...process.env, SEAT_API_KEY: 'sk-test-0123456789abcdef' };
  const toolFrames = [
    ...partialMessage(['Let me run the test', 's']),
    ...toolUse('toolu_b', 'Bash'),
    toolResult('toolu_b'),
    ...toolUse('toolu_c', 'Read'),
    toolResult('toolu_c'),
  ];

  it('shows each tool use before the held end of the main word', async () => {
    const { order } = await invokeSeat(
      lines([...toolFrames, ...partialMessage(['All pass.']), result('All pass.')]),
      keyEnv,
    );

    expect(order).toEqual([
      'text Let me run the test',
      'tool Bash',
      'tool Read',
      'text s +continues',
      'text All pass.',
    ]);
  });

  it('stops at the tool call limit while the main text holds a key prefix', async () => {
    const { call } = await invokeSeat(lines(toolFrames), keyEnv, {
      maxToolCalls: 1,
      keepRunning: true,
    });

    expect(call.status).toBe('truncated');
    expect(call.error?.code).toBe('runner_call_tool_use_stop');
  });
});

describe('a sub-agent text holds a key prefix across its own tool use', () => {
  const keyEnv = { ...process.env, SEAT_API_KEY: 'sk-test-0123456789abcdef' };

  it('marks the held end of the sub-agent word after its own tool row', async () => {
    const { order } = await invokeSeat(
      lines([
        ...partialMessage(['Checking.']),
        ...toolUse('toolu_a', 'Task'),
        ...partialMessage(['Reading the test', 's'], 'toolu_a'),
        ...toolUse('toolu_r', 'Read', 'toolu_a'),
        toolResult('toolu_r', 'toolu_a'),
        ...partialMessage(['Found 3.'], 'toolu_a'),
        toolResult('toolu_a'),
        ...partialMessage(['Done.']),
        result('Done.'),
      ]),
      keyEnv,
    );

    expect(order).toEqual([
      'text Checking.',
      'text Reading the test +subagent',
      'tool Read',
      'text s +continues +subagent',
      'text Found 3. +subagent',
      'tool Task',
      'text Done.',
    ]);
  });

  it('marks the masked held end of a sub-agent text that its Task result ends', async () => {
    const { order } = await invokeSeat(
      lines([
        ...partialMessage(['Checking.']),
        ...toolUse('toolu_a', 'Task'),
        ...partialMessage(['Reading the test', 's'], 'toolu_a'),
        ...toolUse('toolu_r', 'Read', 'toolu_a'),
        toolResult('toolu_r', 'toolu_a'),
        toolResult('toolu_a'),
        ...partialMessage(['Done.']),
        result('Done.'),
      ]),
      keyEnv,
    );

    expect(order).toEqual([
      'text Checking.',
      'text Reading the test +subagent',
      'tool Read',
      'text ***REDACTED*** +continues +subagent',
      'tool Task',
      'text Done.',
    ]);
  });

  it('never prints a key that a sub-agent tool use splits in clear', async () => {
    const secret = 'split-stdout-canary-9274';
    const { call, output, events } = await invokeSeat(
      lines([
        ...partialMessage(['Checking.']),
        ...toolUse('toolu_a', 'Task'),
        ...partialMessage(['token split-stdo'], 'toolu_a'),
        ...toolUse('toolu_r', 'Read', 'toolu_a'),
        toolResult('toolu_r', 'toolu_a'),
        ...partialMessage(['ut-canary-9274 end'], 'toolu_a'),
        toolResult('toolu_a'),
        ...partialMessage(['Done.']),
        result('Done.'),
      ]),
      { ...process.env, SEAT_API_KEY: secret },
    );

    expect(output).toBe('Checking.token ***REDACTED*** endDone.');
    expect(call.text).toBe('Checking.Done.');
    expect(JSON.stringify(events)).not.toContain('split-stdo');
    expect(JSON.stringify(events)).not.toContain('ut-canary');
  });

  it('keeps the marks of a sub-agent text that waits behind a main hold', async () => {
    const { order } = await invokeSeat(
      lines([
        ...partialMessage(['Checking ', 'tests']),
        ...toolUse('toolu_a', 'Task'),
        ...partialMessage(['Reading the test', 's'], 'toolu_a'),
        ...toolUse('toolu_r', 'Read', 'toolu_a'),
        toolResult('toolu_r', 'toolu_a'),
        ...partialMessage(['Found 3.'], 'toolu_a'),
        toolResult('toolu_a'),
        ...partialMessage(['Done.']),
        result('Done.'),
      ]),
      keyEnv,
    );

    expect(order).toEqual([
      'text Checking ',
      'text test',
      'tool Read',
      'tool Task',
      'text s +continues',
      'text Reading the test +subagent',
      'text s +continues +subagent',
      'text Found 3. +subagent',
      'text Done.',
    ]);
  });
});
