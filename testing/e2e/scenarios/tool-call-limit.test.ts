import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadConfig, writeConfig } from '../../../src/core/config/load/io.js';
import { sessionsRoot } from '../../../src/core/paths.js';
import type { ConsultAnswer } from '../../../src/core/schemas/consult.js';
import { deriveRunStatus } from '../../../src/core/sessions/run-status.js';
import { readRunEvents } from '../../../src/engine/events/replay.js';
import { cleanupTempDir } from '#testing/helpers/temp-dir.js';
import {
  cli,
  createStopContinueFixture,
  GREET_FILE,
  GREET_SOURCE,
  MARKER_FILE,
  MARKER_SOURCE,
  readState,
  type StopContinueFixture,
} from '../helpers/stop-continue-fixture.js';

/** How long the implementer holds before the call past the limit; a backstop, not a pace. */
const HOLD_MS = 30_000;

const ASK_USER: ConsultAnswer = {
  answer: {
    diagnosis: 'The attempt read files without end.',
    action: 'ask-user',
    question: 'Which files should the greeting read?',
    whyOnlyUserCanAnswer: 'Only you know which files matter.',
    choices: null,
    default: null,
  },
};

let fixture: StopContinueFixture | undefined;

afterEach(() => {
  if (fixture !== undefined) cleanupTempDir(fixture.tmpDir);
  fixture = undefined;
});

/**
 * A stream-json agent implementer: it writes the brief's two files, then reports `toolCalls`
 * finished reads, each one's number appended to `callsPath` before it is reported, and answers.
 * With `holdBefore`, it holds before that call, so a call the run stops never reaches it.
 */
function implementerScript(callsPath: string, toolCalls: number, holdBefore: number | null) {
  return `import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';

for await (const chunk of process.stdin) void chunk;
mkdirSync('src', { recursive: true });
writeFileSync(${JSON.stringify(MARKER_FILE)}, ${JSON.stringify(MARKER_SOURCE)});
writeFileSync(${JSON.stringify(GREET_FILE)}, ${JSON.stringify(GREET_SOURCE)});
const emit = (record) => process.stdout.write(JSON.stringify(record) + '\\n');
for (let call = 1; call <= ${toolCalls}; call += 1) {
  if (call === ${JSON.stringify(holdBefore)}) await delay(${HOLD_MS});
  appendFileSync(${JSON.stringify(callsPath)}, call + '\\n');
  const id = 'tool-' + call;
  emit({ type: 'assistant', message: { content: [{ type: 'tool_use', id, name: 'Read', input: { path: 'file-' + call + '.ts' } }] } });
  emit({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id }] } });
}
emit({ type: 'result', result: 'Implemented the greeting.' });
`;
}

/** Starts a run whose implementer makes `toolCalls` tool calls and returns its events. */
async function runWithToolCalls(opts: {
  toolCalls: number;
  maxToolCalls?: number;
  holdBefore?: number;
}) {
  let callsPath = '';
  const target = createStopContinueFixture(
    (projectDir) => {
      callsPath = join(dirname(projectDir), 'tool-calls');
      return implementerScript(callsPath, opts.toolCalls, opts.holdBefore ?? null);
    },
    {
      isolation: 'none',
      // Anchored to the heading line: the plan prompt's repo map quotes this line of the script.
      consult: () =>
        `(prompt) => /^# Consult on a failing task$/m.test(prompt) ? ${JSON.stringify(JSON.stringify(ASK_USER))} : undefined`,
    },
  );
  fixture = target;
  const config = loadConfig(target.projectDir).config;
  if (config.implementer.kind !== 'agent') throw new Error('Expected the agent fixture runner');
  writeConfig(target.projectDir, {
    ...config,
    implementer: {
      ...config.implementer,
      outputFormat: 'stream-json',
      ...(opts.maxToolCalls !== undefined && { maxToolCalls: opts.maxToolCalls }),
    },
  });
  const run = await cli(target, ['start', 'smoke']);
  const [sessionId] = readdirSync(sessionsRoot(target.projectDir));
  if (sessionId === undefined) throw new Error(`the run left no session: ${run.stderr}`);
  const { events } = await readRunEvents({ projectDir: target.projectDir, sessionId });
  const implementerEvents = events.filter(
    (event) => 'role' in event && event.role === 'implementer',
  );
  return {
    target,
    run,
    sessionId,
    events: implementerEvents,
    calls: readFileSync(callsPath, 'utf8').trim().split('\n'),
  };
}

describe('e2e: implementer tool-call limit', () => {
  it('finishes a brief past 256 tool calls and keeps its edit when no maxToolCalls is set', async () => {
    const { target, run, sessionId, events, calls } = await runWithToolCalls({ toolCalls: 300 });

    expect(run.exitCode, `${run.stdout}\n${run.stderr}`).toBe(0);
    expect(run.stdout).toContain('task T001: done');
    expect(calls).toHaveLength(300);
    const done = events
      .filter((event) => event.type === 'runner_call_tool_use')
      .filter((event) => event.stage === 'done');
    expect(done).toHaveLength(300);
    expect(events.filter((event) => event.type === 'runner_call_error')).toEqual([]);
    expect(events.filter((event) => event.type === 'runner_call_completed')).toHaveLength(1);
    expect(readFileSync(target.greetPath, 'utf8')).toBe(GREET_SOURCE);
    expect(deriveRunStatus({ state: readState(target, sessionId), liveness: 'not-alive' })).toEqual(
      { kind: 'closed', as: 'complete' },
    );
  });

  it('stops the call at the tool call after maxToolCalls and consults without a retry', async () => {
    const { target, run, sessionId, events, calls } = await runWithToolCalls({
      toolCalls: 20,
      maxToolCalls: 10,
      holdBefore: 12,
    });

    expect(run.exitCode, `${run.stdout}\n${run.stderr}`).toBe(1);
    expect(calls).toEqual(Array.from({ length: 11 }, (_, index) => String(index + 1)));
    expect(events.filter((event) => event.type === 'runner_call_started')).toHaveLength(1);
    const errors = events.filter((event) => event.type === 'runner_call_error');
    expect(errors).toMatchObject([
      { status: 'truncated', error: { code: 'runner_call_tool_use_stop' } },
    ]);
    const message = errors[0]?.error.message ?? '';
    expect(message).toContain(
      'The call reached the maxToolCalls limit of 10 tool calls and was stopped.',
    );
    expect(message).toContain('file-11.ts');
    expect(message).not.toContain('file-12.ts');
    expect(readState(target, sessionId).pendingRecovery?.message).toBe('T001 needs your answer');
  });
});
