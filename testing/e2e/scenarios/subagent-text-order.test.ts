import { readFileSync, readdirSync } from 'node:fs';
import { expect, it, vi } from 'vitest';
import { loadConfig, writeConfig } from '../../../src/core/config/load/io.js';
import { sessionsRoot } from '../../../src/core/paths.js';
import { readRunEvents } from '../../../src/engine/events/replay.js';
import { cleanupTempDir } from '#testing/helpers/temp-dir.js';
import {
  cli,
  createStopContinueFixture,
  GREET_FILE,
  GREET_SOURCE,
  MARKER_FILE,
  MARKER_SOURCE,
  type StopContinueFixture,
} from '../helpers/stop-continue-fixture.js';
import { transcriptText } from '../helpers/transcript-text.js';

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

function stdoutOf(frames: Frame[]): string {
  return frames.map((frame) => `${JSON.stringify(frame)}\n`).join('');
}

const ROW_ONE_STDOUT = stdoutOf([
  ...partialMessage(['Checking ', 'tests']),
  ...toolUse('toolu_a', 'Task'),
  ...textDeltas(['Found 3.'], 'toolu_a'),
  toolResult('toolu_a'),
  ...partialMessage(['Done.']),
  result('Done.'),
]);

const SUBAGENT_HOLD_STDOUT = stdoutOf([
  ...partialMessage(['Checking.']),
  ...toolUse('toolu_a', 'Task'),
  ...partialMessage(['Reading the test', 's'], 'toolu_a'),
  ...toolUse('toolu_r', 'Read', 'toolu_a'),
  toolResult('toolu_r', 'toolu_a'),
  ...partialMessage(['Found 3.'], 'toolu_a'),
  toolResult('toolu_a'),
  ...partialMessage(['Done.']),
  result('Done.'),
]);

/** Runs `start smoke` with an agent BUILD seat that gets a key, and reads the run events. */
async function runKeyedAgentSeat(target: StopContinueFixture) {
  const config = loadConfig(target.projectDir).config;
  if (config.implementer.kind !== 'agent') {
    throw new Error(`Expected agent implementer, got ${config.implementer.kind}`);
  }
  writeConfig(target.projectDir, {
    ...config,
    implementer: {
      ...config.implementer,
      outputFormat: 'stream-json',
      env: ['SEAT_API_KEY'],
    },
  });

  const run = await cli(target, ['start', 'smoke']);
  expect(run.exitCode, run.stderr).toBe(0);
  expect(readFileSync(target.greetPath, 'utf8')).toBe(GREET_SOURCE);
  expect(readFileSync(target.markerPath, 'utf8')).toBe(MARKER_SOURCE);

  const sessionIds = readdirSync(sessionsRoot(target.projectDir));
  expect(sessionIds).toHaveLength(1);
  const sessionId = sessionIds[0];
  if (sessionId === undefined) throw new Error('Expected one session directory');

  const { events } = await readRunEvents({ projectDir: target.projectDir, sessionId });
  return { run, events };
}

function agentSeatScript(stdout: string): () => string {
  return () => `import { mkdirSync, writeFileSync } from 'node:fs';
for await (const chunk of process.stdin) void chunk;
mkdirSync('src', { recursive: true });
writeFileSync(${JSON.stringify(MARKER_FILE)}, ${JSON.stringify(MARKER_SOURCE)});
writeFileSync(${JSON.stringify(GREET_FILE)}, ${JSON.stringify(GREET_SOURCE)});
process.stdout.write(${JSON.stringify(stdout)});
`;
}

it('shows the sub-agent text after the main text it interrupts while a key prefix is held', async () => {
  const target = createStopContinueFixture(agentSeatScript(ROW_ONE_STDOUT), { isolation: 'none' });
  vi.stubEnv('SEAT_API_KEY', 'sk-test-0123456789abcdef');
  try {
    const { run, events } = await runKeyedAgentSeat(target);
    const transcript = transcriptText(events);

    expect(transcript).toMatch(/Checking tests[\s\S]*Found 3\.[\s\S]*Done\./);
    expect(transcript).not.toContain('testFound');
    expect(transcript).not.toContain('sDone');
    expect(run.stdout).not.toContain('testFound');
    expect(run.stdout).not.toContain('sDone');

    const taskRow = events.findIndex(
      (event) => event.type === 'runner_call_activity' && event.kind === 'task',
    );
    const heldEnd = events.findIndex(
      (event) =>
        event.type === 'planner_text' && event.role === 'implementer' && event.text === 's',
    );
    expect(taskRow).toBeGreaterThanOrEqual(0);
    expect(heldEnd).toBeGreaterThan(taskRow);
  } finally {
    vi.unstubAllEnvs();
    cleanupTempDir(target.tmpDir);
  }
});

it('keeps a sub-agent word whole when its own tool row comes before the end of the word', async () => {
  const target = createStopContinueFixture(agentSeatScript(SUBAGENT_HOLD_STDOUT), {
    isolation: 'none',
  });
  vi.stubEnv('SEAT_API_KEY', 'sk-test-0123456789abcdef');
  try {
    const { events } = await runKeyedAgentSeat(target);
    const transcript = transcriptText(events);

    expect(transcript).toMatch(/Reading the tests[\s\S]*Found 3\.[\s\S]*Done\./);
    expect(transcript).not.toContain('sFound');
  } finally {
    vi.unstubAllEnvs();
    cleanupTempDir(target.tmpDir);
  }
});

const PARALLEL_HOLD_STDOUT = stdoutOf([
  ...partialMessage(['Checking.']),
  ...toolUse('toolu_a', 'Task'),
  ...toolUse('toolu_b', 'Task'),
  ...partialMessage(['Reading the tests'], 'toolu_a'),
  ...partialMessage(['Looking at it.'], 'toolu_b'),
  ...toolUse('toolu_r', 'Read', 'toolu_b'),
  toolResult('toolu_r', 'toolu_b'),
  ...partialMessage(['Found 3.'], 'toolu_a'),
  toolResult('toolu_a'),
  toolResult('toolu_b'),
  ...partialMessage(['Done.']),
  result('Done.'),
]);

it('gives each parallel sub-agent its own row and keeps its held word end in that row', async () => {
  const target = createStopContinueFixture(agentSeatScript(PARALLEL_HOLD_STDOUT), {
    isolation: 'none',
  });
  vi.stubEnv('SEAT_API_KEY', 'sk-test-0123456789abcdef');
  try {
    const { events } = await runKeyedAgentSeat(target);
    const lines = transcriptText(events).split('\n');
    const rowOf = (text: string) => lines.filter((line) => line.includes(text));

    expect(rowOf('Reading the tests')).toHaveLength(1);
    expect(rowOf('Reading the tests')[0]).not.toContain('Looking');
    expect(rowOf('Looking at it.')).toHaveLength(1);
    expect(rowOf('Looking at it.')[0]).not.toMatch(/it\.s|Reading/);
    const subagentText = (id: string) =>
      events.flatMap((event) =>
        event.type === 'planner_text' && event.subagentId === id ? [event.text] : [],
      );
    expect(subagentText('toolu_a')).toEqual(['Reading the test', 's', 'Found 3.']);
    expect(subagentText('toolu_b')).toEqual(['Looking at it.']);
  } finally {
    vi.unstubAllEnvs();
    cleanupTempDir(target.tmpDir);
  }
});
