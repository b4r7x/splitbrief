import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { makeRunnerCallResult } from '#testing/helpers/factories/runner-call.js';
import type { RunnerCallContext, RunnerCallResult } from '../calls/types.js';
import { isRecord } from '../../utils/type-guards.js';
import { createStreamHandler, finishClaudeStream } from './claude/stream.js';
import { antigravityPlannerAdapter, antigravityProtocolEvents } from './cli-tools/antigravity.js';
import { claudeProtocolEvents } from './cli-tools/claude-code.js';
import { codexPlannerAdapter, codexProtocolEvents } from './cli-tools/codex.js';
import { extractLastJsonObject, requestTyped, type TypedSeatCall } from './typed-output.js';

const FIXTURE_DIR = join(import.meta.dirname, '../../../testing/fixtures/typed-output');
const CLAUDE_FIXTURE = 'claude-code-2.1.286.jsonl';
const CODEX_FIXTURE = 'codex-0.157.1.jsonl';
const ANTIGRAVITY_FIXTURE = 'antigravity-1.2.14.jsonl';

const schema = z.object({ answer: z.string(), count: z.number() });
const jsonSchema: Readonly<Record<string, unknown>> = {
  type: 'object',
  properties: { answer: { type: 'string' }, count: { type: 'number' } },
  required: ['answer', 'count'],
  additionalProperties: false,
};
const expected = { answer: 'ok', count: 3 };

function fixtureLines(name: string): string[] {
  return readFileSync(join(FIXTURE_DIR, name), 'utf8')
    .split('\n')
    .filter((line) => line.trim().length > 0);
}

function jsonRecord(line: string): Record<string, unknown> {
  const value: unknown = JSON.parse(line);
  if (!isRecord(value)) throw new Error('fixture line is not a JSON object');
  return value;
}

async function replayedValue(input: { text: string; structured?: unknown }): Promise<unknown> {
  const call: TypedSeatCall = {
    seat: 'planner',
    typedOutput: 'native',
    canResume: false,
    invoke: async (): Promise<RunnerCallResult> =>
      makeRunnerCallResult({
        status: 'completed',
        text: input.text,
        ...(input.structured !== undefined && { structured: input.structured }),
      }),
  };
  const result = await requestTyped({
    prompt: 'Reply with answer "ok" and count 3.',
    schema,
    jsonSchema,
    schemaName: 'typed_output_probe',
    call,
  });
  expect('value' in result).toBe(true);
  if (!('value' in result)) throw new Error(result.error.message);
  return result.value;
}

function claudeContext(): RunnerCallContext {
  return {
    callId: 'typed-output-replay-claude',
    role: 'review',
    backendKind: 'cli',
    runnerName: 'claude',
  };
}

describe('typed-output fixture replay', () => {
  it('replays the recorded claude-code call through the protocol parser and the stream handler', async () => {
    const lines = fixtureLines(CLAUDE_FIXTURE);
    const resultRecord = lines.map(jsonRecord).find((record) => record.type === 'result');
    if (resultRecord === undefined) throw new Error('claude fixture has no result record');
    const structuredOutput = resultRecord.structured_output;

    const events = lines.flatMap((line) => claudeProtocolEvents(line));
    const results = events.filter((event) => event.type === 'result');
    expect(results).toHaveLength(1);
    const terminal = results[0];
    if (terminal === undefined || terminal.type !== 'result' || terminal.status !== 'completed') {
      throw new Error('claude fixture has no completed result event');
    }
    expect(terminal.structured).toEqual(structuredOutput);
    expect(schema.parse(terminal.structured)).toEqual(expected);

    const { state, handleLine } = createStreamHandler({
      context: claudeContext(),
      onOutput: () => {},
    });
    for (const line of lines) handleLine(line);
    const streamed = finishClaudeStream(state);
    expect(streamed.status).toBe('completed');
    if (streamed.status !== 'completed') throw new Error('expected a completed claude stream');
    expect(streamed.structured).toEqual(structuredOutput);

    const value = await replayedValue({
      text: streamed.text,
      ...(streamed.structured !== undefined && { structured: streamed.structured }),
    });
    expect(value).toEqual(expected);
  });

  it('replays the recorded codex call through the protocol adapter', async () => {
    const lines = fixtureLines(CODEX_FIXTURE);
    const terminal = codexPlannerAdapter.terminal({
      outputContract: codexPlannerAdapter.outputContract,
      events: lines.flatMap((line) => codexProtocolEvents(line)),
      stderr: '',
      exitCode: 0,
      signal: null,
    });
    expect(terminal.status).toBe('completed');
    if (terminal.status !== 'completed') throw new Error('codex fixture has no completed terminal');
    const extracted = extractLastJsonObject(terminal.text);
    expect(extracted.kind).toBe('ok');
    if (extracted.kind !== 'ok') throw new Error('codex terminal text has no JSON object');
    expect(schema.parse(extracted.value)).toEqual(expected);

    expect(await replayedValue({ text: terminal.text })).toEqual(expected);
  });

  it('replays the recorded antigravity call through the protocol adapter', async () => {
    const lines = fixtureLines(ANTIGRAVITY_FIXTURE);
    const resultRecord = lines.map(jsonRecord).find((record) => record.event === 'result');
    if (resultRecord === undefined || !isRecord(resultRecord.result)) {
      throw new Error('antigravity fixture has no result record');
    }
    const structuredOutput = resultRecord.result.structured_output;
    const terminal = antigravityPlannerAdapter.terminal({
      outputContract: antigravityPlannerAdapter.outputContract,
      events: lines.flatMap((line) => antigravityProtocolEvents(line)),
      stderr: '',
      exitCode: 0,
      signal: null,
    });
    expect(terminal.status).toBe('completed');
    if (terminal.status !== 'completed') {
      throw new Error('antigravity fixture has no completed terminal');
    }
    expect(terminal.structured).toEqual(structuredOutput);
    expect(schema.strict().parse(terminal.structured)).toEqual(expected);

    expect(await replayedValue({ text: terminal.text, structured: terminal.structured })).toEqual(
      expected,
    );
  });
});
