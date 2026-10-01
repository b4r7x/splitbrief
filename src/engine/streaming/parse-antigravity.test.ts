import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { CliProtocolEvent } from '../runners/cli-tools/contract.js';
import { parseAntigravityLine } from './parse-antigravity.js';

const FIXTURES = join(import.meta.dirname, '../../../testing/fixtures/antigravity');

type ToolUseEvent = Extract<CliProtocolEvent, { type: 'tool-use' }>;
type UsageEvent = Extract<CliProtocolEvent, { type: 'usage' }>;
type ResultEvent = Extract<CliProtocolEvent, { type: 'result' }>;

function fixtureEvents(name: string): readonly CliProtocolEvent[] {
  return readFileSync(join(FIXTURES, name), 'utf8')
    .split('\n')
    .filter((line) => line.length > 0)
    .flatMap((line) => [...parseAntigravityLine(line)]);
}

function toolUses(events: readonly CliProtocolEvent[]): ToolUseEvent[] {
  return events.filter((event): event is ToolUseEvent => event.type === 'tool-use');
}

function usages(events: readonly CliProtocolEvent[]): UsageEvent[] {
  return events.filter((event): event is UsageEvent => event.type === 'usage');
}

function terminalOf(events: readonly CliProtocolEvent[]): ResultEvent | undefined {
  return events.find((event): event is ResultEvent => event.type === 'result');
}

describe('parseAntigravityLine', () => {
  it('reads the conversation id from the init frame as the session', () => {
    expect(fixtureEvents('stream-json.ndjson')[0]).toEqual({
      type: 'session',
      nativeSessionId: '50328626-c5df-4301-9da7-dee7ce900271',
    });
  });

  it('pairs every tool step as started then done under the same step id', () => {
    const tools = toolUses(fixtureEvents('stream-json.ndjson'));

    expect(tools.map((event) => [event.id, event.stage])).toEqual([
      ['step-2', 'started'],
      ['step-2', 'done'],
      ['step-4', 'started'],
      ['step-4', 'done'],
      ['step-6', 'started'],
      ['step-6', 'done'],
    ]);
    expect(tools[0]).toEqual({
      type: 'tool-use',
      stage: 'started',
      id: 'step-2',
      name: 'run_command',
      input: { CommandLine: 'pwd; ls -la README.md' },
    });
    expect(tools[1]).toMatchObject({
      stage: 'done',
      name: 'run_command',
      input: { CommandLine: 'pwd; ls -la README.md' },
      output: expect.stringContaining('No such file or directory'),
    });
    expect(tools[4]).toMatchObject({
      stage: 'started',
      name: 'view_file',
      input: { AbsolutePath: '/tmp/probe/README.md' },
    });
    expect(tools[5]).toMatchObject({ stage: 'done', output: '4 lines, 55 bytes' });
  });

  it('streams the response as assistant text deltas that concatenate to the result response', () => {
    const events = fixtureEvents('stream-json-long.ndjson');
    const streamed = events
      .flatMap((event) => (event.type === 'text' ? [event.text] : []))
      .join('');
    const terminal = terminalOf(events);

    expect(streamed).toBe(
      'The [README.md](file:///tmp/probe/README.md) file introduces a project titled "Probe". It states that the repository is a throwaway probe environment intended for agy. There are no further setup steps or documentation provided in the file.\n',
    );
    expect(terminal).toMatchObject({
      type: 'result',
      status: 'completed',
      text: streamed,
      nativeSessionId: 'e5a9bdab-e766-4e3f-a659-03cca56645a0',
      error: null,
      partial: false,
    });
    expect(events.at(-1)).toBe(terminal);
  });

  it('books each response step as a usage delta whose sum is the result total', () => {
    const events = fixtureEvents('stream-json.ndjson');
    const deltas = usages(events);

    expect(deltas).toHaveLength(4);
    expect(deltas[0]).toEqual({
      type: 'usage',
      semantics: 'delta',
      usage: { inputTokens: 14018, outputTokens: 76, reasoningTokens: 674, cacheReadTokens: 0 },
    });
    const summed = deltas.reduce(
      (total, event) => ({
        inputTokens: total.inputTokens + event.usage.inputTokens,
        outputTokens: total.outputTokens + event.usage.outputTokens,
        reasoningTokens: total.reasoningTokens + (event.usage.reasoningTokens ?? 0),
        cacheReadTokens: total.cacheReadTokens + (event.usage.cacheReadTokens ?? 0),
      }),
      { inputTokens: 0, outputTokens: 0, reasoningTokens: 0, cacheReadTokens: 0 },
    );
    expect(terminalOf(events)?.usage).toEqual(summed);
    expect(summed).toEqual({
      inputTokens: 59864,
      outputTokens: 272,
      reasoningTokens: 999,
      cacheReadTokens: 0,
    });
  });

  it('carries a json-schema call structured_output on the completed terminal', () => {
    expect(
      parseAntigravityLine(
        JSON.stringify({
          event: 'result',
          result: {
            conversation_id: 'conv-1',
            status: 'SUCCESS',
            response: 'ok',
            structured_output: { answer: 'ok', count: 3 },
          },
        }),
      ),
    ).toMatchObject([
      { type: 'result', status: 'completed', text: 'ok', structured: { answer: 'ok', count: 3 } },
    ]);
  });

  it('maps a non-SUCCESS result to a failed terminal (shape unverified against a live failure)', () => {
    expect(
      parseAntigravityLine(
        JSON.stringify({
          event: 'result',
          result: {
            conversation_id: 'conv-1',
            status: 'ERROR',
            response: 'partial answer',
            error: 'Individual quota reached.',
          },
        }),
      ),
    ).toEqual([
      {
        type: 'result',
        status: 'failed',
        text: 'partial answer',
        usage: null,
        nativeSessionId: 'conv-1',
        error: { code: 'antigravity-result-failed', message: 'Individual quota reached.' },
        partial: true,
      },
    ]);
    expect(
      parseAntigravityLine(JSON.stringify({ event: 'result', result: { status: 'CANCELLED' } })),
    ).toMatchObject([{ status: 'failed', error: { message: 'Antigravity result CANCELLED' } }]);
  });

  // Captured live from `agy -p` (antigravity 1.2.9) on 2026-09-23 when a background task
  // finished: the frame carries no text, usage or tool data; the notice stays in agy's transcript.
  it('skips the system message step that marks a finished background task', () => {
    expect(
      parseAntigravityLine(
        '{"event":"step_update","step_update":{"conversation_id":"562988bb-f747-429c-a37a-80dbf110ed38","step_index":4,"state":"DONE","step_type":"system_message","duration_seconds":0.00017}}',
      ),
    ).toEqual([]);
  });

  it('skips user input, warns on unknown records, and fails the call on malformed JSON', () => {
    expect(
      parseAntigravityLine(
        JSON.stringify({
          event: 'step_update',
          step_update: { step_index: 0, state: 'DONE', step_type: 'user_input' },
        }),
      ),
    ).toEqual([]);
    expect(parseAntigravityLine(JSON.stringify({ event: 'heartbeat' }))).toEqual([
      {
        type: 'warning',
        code: 'unknown-antigravity-record',
        message: 'Unknown Antigravity record',
      },
    ]);
    expect(parseAntigravityLine('{not-json')).toEqual([
      {
        type: 'result',
        status: 'failed',
        text: '',
        usage: null,
        nativeSessionId: null,
        error: {
          code: 'malformed-antigravity-json',
          message: 'Antigravity emitted malformed JSON',
        },
        partial: false,
      },
    ]);
    expect(parseAntigravityLine('')).toEqual([]);
  });
});
