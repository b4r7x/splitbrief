import { realpathSync, statSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { invokeTestClaude } from '#testing/helpers/claude-planner-steer-test-invoke.js';
import { installClaudeShim } from '#testing/helpers/claude-cli-shim.js';
import { prependPath } from '#testing/helpers/command-shim.js';
import { cleanupTempDir, createTempDir } from '#testing/helpers/temp-dir.js';
import type { RunnerCallEvent } from '../calls/types.js';
import { invokeCommandRunner } from './command-based.js';

const SESSION = 'c3d312ab-5629-4ee2-aadd-d8da74b13c91';
type Frame = Record<string, unknown>;

let shimDir: string;
let projectDir: string;
let restorePath: () => void;

beforeEach(() => {
  shimDir = createTempDir('stream-json-parity-shim');
  projectDir = createTempDir('stream-json-parity-project');
  restorePath = prependPath(shimDir);
});

afterEach(() => {
  restorePath();
  cleanupTempDir(shimDir);
  cleanupTempDir(projectDir);
});

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
    callContext: { callId: 'call-parity', role: 'review', backendKind: 'shell' },
    onOutput: (chunk) => output.push(chunk),
    onCallEvent: (event) => events.push(event),
  });
  return { call, output: output.join(''), events };
}

async function invokeReply(bodyLines: readonly string[]) {
  const executablePath = realpathSync(installClaudeShim(shimDir, [...bodyLines]));
  const { dev, ino, size, mtimeMs } = statSync(executablePath);
  const output: string[] = [];
  const call = await invokeTestClaude({
    prompt: 'Reply to the test prompt.',
    projectDir,
    executable: { path: executablePath, fingerprint: { dev, ino, size, mtimeMs } },
    onOutput: (text) => output.push(text),
  });
  return { call, output: output.join('') };
}

async function seatTexts(frames: Frame[]) {
  const shell = await invokeSeat(lines(frames));
  const builtin = await invokeReply(frames.map((frame) => JSON.stringify(frame)));
  return {
    shellAnswer: shell.call.text,
    shellLive: shell.output,
    builtinAnswer: builtin.call.text,
    builtinLive: builtin.output,
  };
}

describe('stream-json shell and built-in seats', () => {
  it('gives one answer on every path when a record restates its deltas with other text', async () => {
    const frames = [
      ...partialMessage(['Hel', 'world.']).map((frame) =>
        frame.type === 'assistant' ? assistant([{ type: 'text', text: 'Hello world.' }]) : frame,
      ),
      result(''),
    ];
    const answer = 'Helworld.Hello world.';

    expect(await seatTexts(frames)).toEqual({
      shellAnswer: answer,
      shellLive: answer,
      builtinAnswer: answer,
      builtinLive: answer,
    });
  });

  it('gives one answer on every path when a record with only a tool use closes the streamed block', async () => {
    const frames = [
      streamEvent({ type: 'message_start', message: { role: 'assistant', content: [] } }),
      ...textDeltas(['Do', 'ne.']),
      ...toolUse('toolu_read', 'Read'),
      toolResult('toolu_read'),
      assistant([{ type: 'text', text: 'Done.' }]),
      result(''),
    ];
    const answer = 'Done.Done.';

    expect(await seatTexts(frames)).toEqual({
      shellAnswer: answer,
      shellLive: answer,
      builtinAnswer: answer,
      builtinLive: answer,
    });
  });

  const delegatedPartial = partialMessage(['Deleg', 'ating.']);
  const subagentStreams: Record<'partial messages' | 'whole records', Frame[]> = {
    'partial messages': [
      ...delegatedPartial,
      ...toolUse('toolu_a', 'Task'),
      ...textDeltas(['A says ', 'hi.'], 'toolu_a'),
      assistant([{ type: 'text', text: 'A says hi.' }], 'toolu_a'),
      toolResult('toolu_a'),
      ...partialMessage(['{"verdict":', '"pass"}']),
      result('{"verdict":"pass"}'),
    ],
    'whole records': [
      assistant([{ type: 'text', text: 'Delegating.' }]),
      assistant([{ type: 'tool_use', id: 'toolu_a', name: 'Task', input: {} }]),
      assistant([{ type: 'text', text: 'A says hi.' }], 'toolu_a'),
      toolResult('toolu_a'),
      assistant([{ type: 'text', text: '{"verdict":"pass"}' }]),
      result('{"verdict":"pass"}'),
    ],
  };

  it.each(['partial messages', 'whole records'] as const)(
    'gives one answer on a shell seat and on the built-in seat when a subagent answers first, with %s',
    async (kind) => {
      const frames =
        kind === 'partial messages'
          ? subagentStreams[kind].slice(delegatedPartial.length)
          : subagentStreams[kind].slice(1);
      const live = 'A says hi.{"verdict":"pass"}';

      expect(await seatTexts(frames)).toEqual({
        shellAnswer: '{"verdict":"pass"}',
        shellLive: live,
        builtinAnswer: '{"verdict":"pass"}',
        builtinLive: live,
      });
    },
  );

  it.each(['partial messages', 'whole records'] as const)(
    'keeps main-loop narration but not subagent text on a shell seat, with %s',
    async (kind) => {
      const live = 'Delegating.A says hi.{"verdict":"pass"}';

      expect(await seatTexts(subagentStreams[kind])).toEqual({
        shellAnswer: 'Delegating.{"verdict":"pass"}',
        shellLive: live,
        builtinAnswer: '{"verdict":"pass"}',
        builtinLive: live,
      });
    },
  );

  it('records the model Claude Code reports after a hook frame on a shell seat', async () => {
    const { events } = await invokeSeat(
      lines([
        {
          type: 'system',
          subtype: 'hook_started',
          session_id: SESSION,
          hook_id: 'hook-1',
          hook_name: 'SessionStart:startup',
        },
        { type: 'system', subtype: 'init', session_id: SESSION, model: 'claude-opus-5-5' },
        ...partialMessage(['OK.']),
        result('OK.'),
      ]),
    );

    expect(events).toContainEqual(
      expect.objectContaining({ type: 'call_session_id', resolvedModel: 'claude-opus-5-5' }),
    );
  });
});
