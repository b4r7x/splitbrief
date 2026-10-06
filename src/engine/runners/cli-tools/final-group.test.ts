import { realpathSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import type { RunnerCallContext } from '../../calls/types.js';
import { codexPlannerAdapter } from './codex.js';
import type { CliPlannerAdapter } from './contract.js';
import { cursorPlannerAdapter } from './cursor.js';
import { kiloPlannerAdapter } from './kilo-code.js';
import { opencodePlannerAdapter } from './opencode.js';
import { invokeCliAdapter } from '../invoke-cli-adapter.js';

type Step = Readonly<{ message: string }> | 'tool';

const opencodeLines = (steps: readonly Step[]): string[] =>
  [
    ...steps.map((step) =>
      step === 'tool'
        ? { type: 'tool_result', sessionID: 's', part: { type: 'tool', id: 't', name: 'read' } }
        : { type: 'text', sessionID: 's', part: { type: 'text', text: step.message } },
    ),
    {
      type: 'step_finish',
      sessionID: 's',
      part: { type: 'step-finish', tokens: { input: 1, output: 1 } },
    },
  ].map((record) => JSON.stringify(record));

const RUNNERS: Readonly<
  Record<string, { adapter: CliPlannerAdapter; lines: (steps: readonly Step[]) => string[] }>
> = {
  codex: {
    adapter: codexPlannerAdapter,
    lines: (steps) =>
      [
        { type: 'thread.started', thread_id: 'thread' },
        ...steps.map((step) => ({
          type: 'item.completed',
          item:
            step === 'tool'
              ? { type: 'command_execution', id: 't', input: { command: 'cat a.ts' } }
              : { type: 'agent_message', text: step.message },
        })),
        { type: 'turn.completed' },
      ].map((record) => JSON.stringify(record)),
  },
  cursor: {
    adapter: cursorPlannerAdapter,
    lines: (steps) =>
      [
        { type: 'system', subtype: 'init', session_id: 'session' },
        ...steps.map((step) =>
          step === 'tool'
            ? {
                type: 'tool_call',
                subtype: 'completed',
                call_id: 't',
                tool_call: { readToolCall: { args: { path: 'a.ts' }, result: {} } },
              }
            : { type: 'assistant', message: { content: [{ type: 'text', text: step.message }] } },
        ),
        { type: 'result', subtype: 'success', is_error: false },
      ].map((record) => JSON.stringify(record)),
  },
  opencode: { adapter: opencodePlannerAdapter, lines: opencodeLines },
  'kilo-code': { adapter: kiloPlannerAdapter, lines: opencodeLines },
};

const callContext = {
  callId: 'final-group-test',
  role: 'planner',
  backendKind: 'cli',
  runnerName: 'fixture',
} satisfies RunnerCallContext;

/** The text the call returns, and what the live transcript received. */
async function call(
  runner: string,
  steps: readonly Step[],
): Promise<{ text: string; live: string }> {
  const selected = RUNNERS[runner];
  if (selected === undefined) throw new Error(`unknown runner ${runner}`);
  const output = `${selected.lines(steps).join('\n')}\n`;
  const path = realpathSync(process.execPath);
  const info = statSync(path);
  const live: string[] = [];
  const result = await invokeCliAdapter({
    adapter: selected.adapter,
    invocation: {
      executable: {
        path,
        fingerprint: { dev: info.dev, ino: info.ino, size: info.size, mtimeMs: info.mtimeMs },
      },
      args: [
        '-e',
        `process.stdout.write(${JSON.stringify(output)})`,
        ...(selected.adapter.promptTransport.kind === 'argv' ? ['<PROMPT>'] : []),
      ],
      promptTransport: selected.adapter.promptTransport,
      environment: {},
      cwd: tmpdir(),
      timeoutMs: 10_000,
      signal: undefined,
    },
    prompt: 'p',
    callContext,
    onOutput: (text) => live.push(text),
  });
  expect(result.status).toBe('completed');
  return { text: result.text, live: live.join('') };
}

/** Every message reaches the live transcript exactly once, however the final text restates it. */
function expectEachShownOnce(live: string, steps: readonly Step[]): void {
  for (const step of steps) {
    if (step !== 'tool') expect(live.split(step.message)).toHaveLength(2);
  }
}

const VERDICT = 'VERDICT: widen a.ts — r';
const REVIEW = '### Verdict\npass';

describe.each(Object.keys(RUNNERS))('%s final text', (runner) => {
  it('hands the reader a final message that the narration before it does not prefix', async () => {
    const steps: Step[] = [
      { message: 'Reading the failing test.' },
      'tool',
      { message: 'The test pins the path, so widening is right.' },
      { message: VERDICT },
    ];
    const { text, live } = await call(runner, steps);

    expect(text).toBe(`The test pins the path, so widening is right.\n\n${VERDICT}`);
    expectEachShownOnce(live, steps);
  });

  it('keeps a verdict heading on its own paragraph after the narration before it', async () => {
    const steps: Step[] = [
      'tool',
      { message: 'Checking the gates once more.' },
      { message: REVIEW },
    ];
    const { text, live } = await call(runner, steps);

    expect(text).toBe(`Checking the gates once more.\n\n${REVIEW}`);
    expectEachShownOnce(live, steps);
  });

  it('falls back to the last message, not the whole stream, when the turn ends on a tool call', async () => {
    const steps: Step[] = [{ message: 'Reading a.ts first.' }, { message: VERDICT }, 'tool'];
    const { text, live } = await call(runner, steps);

    expect(text).toBe(VERDICT);
    expectEachShownOnce(live, steps);
  });
});
