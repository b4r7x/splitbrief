import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { finishClaudeStream, createStreamHandler, interruptedError } from './stream.js';
import type { RunnerCallContext, RunnerCallEvent } from '../../calls/types.js';
import { RUNNER_CALL_OUTPUT_MAX_BYTES } from '../../calls/output-limit.js';
import { parseHintVerdict } from '../../spec/prompts/escalation.js';
import { parseFinalReview } from '../../parsers/final-review.js';

const context: RunnerCallContext = {
  callId: 'claude-redaction-test',
  role: 'planner',
  backendKind: 'cli',
  runnerName: 'claude',
};

describe('Claude stream credential redaction', () => {
  it('redacts credential values from output callbacks, tool payloads, events, and results', () => {
    const credential = 'opaque-claude-credential-canary-7d93c612';
    const output: string[] = [];
    const events: RunnerCallEvent[] = [];
    const { state, handleLine } = createStreamHandler({
      context,
      credentialValues: [credential],
      onOutput: (text) => output.push(text),
      onCallEvent: (event) => events.push(event),
    });

    handleLine(
      JSON.stringify({
        type: 'assistant',
        message: {
          content: [
            { type: 'text', text: `answer ${credential}` },
            { type: 'tool_use', id: credential, name: 'debug', input: { credential } },
          ],
        },
      }),
    );
    handleLine(JSON.stringify({ type: 'result', result: `answer ${credential}` }));

    const result = finishClaudeStream(state);
    const persisted = JSON.stringify({ result, events, output });
    expect(persisted).not.toContain(credential);
    expect(persisted).toContain('***REDACTED***');
    expect(output).toEqual(['answer ***REDACTED***']);
    expect(result.text).toBe('answer ***REDACTED***');
  });

  it('redacts credential values from in-band failure diagnostics', () => {
    const credential = 'opaque-claude-error-credential-canary-7d93c612';
    const events: RunnerCallEvent[] = [];
    const { state, handleLine } = createStreamHandler({
      context,
      credentialValues: [credential],
      onOutput: () => {},
      onCallEvent: (event) => events.push(event),
    });

    handleLine(JSON.stringify({ type: 'result', is_error: true, result: credential }));

    expect(() => finishClaudeStream(state)).toThrow('***REDACTED***');
    const persisted = JSON.stringify(events);
    expect(persisted).not.toContain(credential);
    expect(persisted).toContain('***REDACTED***');
  });

  it('streams a partial message once when the assistant record restates it', () => {
    const deltas = ['returning `a', ' - b`', '\n\n', 'second para.'];
    const message = deltas.join('');
    const output: string[] = [];
    const { state, handleLine } = createStreamHandler({
      context,
      onOutput: (text) => output.push(text),
    });

    for (const text of deltas) {
      handleLine(
        JSON.stringify({
          type: 'stream_event',
          session_id: 'sess-partial',
          event: { type: 'content_block_delta', delta: { type: 'text_delta', text } },
        }),
      );
    }
    handleLine(
      JSON.stringify({
        type: 'assistant',
        session_id: 'sess-partial',
        message: { content: [{ type: 'text', text: message }] },
      }),
    );
    handleLine(JSON.stringify({ type: 'result', session_id: 'sess-partial', result: message }));

    expect(output.join('')).toBe(message);
    expect(finishClaudeStream(state).text).toBe(message);
  });

  it('returns a typed, redacted interruption while preserving timeout taxonomy', () => {
    const credential = 'opaque-claude-interrupt-credential-canary-7d93c612';
    const controller = new AbortController();
    controller.abort(new DOMException(`cancelled with ${credential}`, 'TimeoutError'));

    const interrupted = interruptedError(controller.signal, new Error('fallback'), (value) =>
      value.replaceAll(credential, '***REDACTED***'),
    );

    expect(interrupted).toMatchObject({
      kind: 'runner-interrupted',
      name: 'TimeoutError',
      message: 'cancelled with ***REDACTED***',
      data: { status: 'timeout', name: 'TimeoutError' },
    });
    expect(JSON.stringify(interrupted)).not.toContain(credential);
  });

  it('keeps only the divergent final response as content, never concatenating partials', () => {
    const { state, handleLine } = createStreamHandler({
      context,
      onOutput: () => {},
    });

    handleLine(
      JSON.stringify({
        type: 'assistant',
        message: { content: [{ type: 'text', text: 'draft text' }] },
      }),
    );
    handleLine(JSON.stringify({ type: 'result', result: 'final text' }));

    const result = finishClaudeStream(state);
    expect(result.status).toBe('completed');
    expect(result.text).toBe('final text');
  });
});

it('observes matching native init even when the resume ID is already seeded', () => {
  const initialized: string[] = [];
  const persisted: string[] = [];
  const { state, handleLine } = createStreamHandler({
    context,
    onOutput: () => {},
    onSessionInit: (id) => initialized.push(id),
    onSessionId: (id) => persisted.push(id),
  });
  state.sessionId = 'sess-old';
  handleLine(JSON.stringify({ type: 'system', subtype: 'init', session_id: 'sess-old' }));
  handleLine(
    JSON.stringify({ type: 'assistant', session_id: 'sess-old', message: { content: [] } }),
  );
  handleLine(JSON.stringify({ type: 'result', session_id: 'sess-old', result: 'done' }));
  expect(initialized).toEqual(['sess-old']);
  expect(persisted).toEqual([]);
});

const FIXTURES = join(import.meta.dirname, '../../../../testing/fixtures/claude-code');

function readFixture(name: string): string {
  return readFileSync(join(FIXTURES, name), 'utf8');
}

/** What the live transcript received, and the text the call returns. */
function replay(lines: readonly string[]): { output: string; text: string } {
  const output: string[] = [];
  const { state, handleLine } = createStreamHandler({
    context,
    onOutput: (text) => output.push(text),
  });
  for (const line of lines) handleLine(line);
  return { output: output.join(''), text: finishClaudeStream(state).text };
}

function streamEvent(event: Record<string, unknown>, parent: string | null = null): string {
  return JSON.stringify({ type: 'stream_event', event, parent_tool_use_id: parent });
}

function textDelta(text: string): string {
  return streamEvent({
    type: 'content_block_delta',
    index: 0,
    delta: { type: 'text_delta', text },
  });
}

function assistantRecord(id: string, text: string, parent: string | null = null): string {
  return JSON.stringify({
    type: 'assistant',
    message: { id, content: [{ type: 'text', text }] },
    parent_tool_use_id: parent,
  });
}

function mainLoopMessage(id: string, text: string, stopReason: string): string[] {
  return [
    streamEvent({ type: 'message_start', message: { id, content: [] } }),
    textDelta(text),
    assistantRecord(id, text),
    streamEvent({ type: 'message_delta', delta: { stop_reason: stopReason } }),
    streamEvent({ type: 'message_stop' }),
  ];
}

describe('Claude stream final text', () => {
  it('returns the document alone while the narration before it still streams live', () => {
    const { output, text } = replay(readFixture('claude-planner-narration.jsonl').split('\n'));

    expect(text).toBe(readFixture('claude-planner-narration.expected.txt'));
    expect(output).toContain('Checking three details the spec must state precisely');
    expect(output).toContain("I'll start by looking at the commits");
  });

  it('keeps a document that max_tokens split across two messages whole', () => {
    const { text } = replay(readFixture('claude-planner-max-tokens.jsonl').split('\n'));

    expect(text).toBe(readFixture('claude-planner-max-tokens.expected.txt'));
  });

  it('does not let a subagent record between main-loop deltas replay the block', () => {
    const { output, text } = replay([
      streamEvent({ type: 'message_start', message: { id: 'msg_main', content: [] } }),
      textDelta('Hel'),
      assistantRecord('msg_sub_1', ' [first] ', 'toolu_agent'),
      textDelta('lo'),
      assistantRecord('msg_sub_2', ' [second]', 'toolu_agent'),
      assistantRecord('msg_main', 'Hello'),
      streamEvent({ type: 'message_delta', delta: { stop_reason: 'end_turn' } }),
      JSON.stringify({ type: 'result', result: 'Hello' }),
    ]);

    expect(text).toBe('Hello');
    expect(output).toBe('Hel [first] lo [second]');
  });

  it('hands the hint reader a verdict line that narration does not prefix', () => {
    const verdict = 'VERDICT: widen a.ts — r';
    const { text } = replay([
      ...mainLoopMessage('msg_narration', 'Reading the failing test before deciding.', 'tool_use'),
      ...mainLoopMessage('msg_verdict', verdict, 'end_turn'),
      JSON.stringify({ type: 'result', result: verdict }),
    ]);

    expect(parseHintVerdict(text)).toEqual({ kind: 'widen', paths: ['a.ts'], reason: 'r' });
  });

  it('hands the final-review reader a verdict heading that narration does not prefix', () => {
    const review = '### Verdict\npass';
    const { text } = replay([
      ...mainLoopMessage('msg_narration', 'Checking the gates once more.', 'tool_use'),
      ...mainLoopMessage('msg_review', review, 'end_turn'),
      JSON.stringify({ type: 'result', result: review }),
    ]);

    expect(parseFinalReview(text).verdict).toBe('pass');
  });

  it.each([
    ['an empty result', { type: 'result', result: '' }],
    ['a result without text', { type: 'result' }],
  ])('takes the last main-loop message, not the narration, from %s', (_label, result) => {
    const verdict = 'VERDICT: widen a.ts — r';
    const { output, text } = replay([
      ...mainLoopMessage('msg_narration', 'Reading the failing test before deciding.', 'tool_use'),
      ...mainLoopMessage('msg_verdict', verdict, 'end_turn'),
      JSON.stringify(result),
    ]);

    expect(text).toBe(verdict);
    expect(parseHintVerdict(text)).toEqual({ kind: 'widen', paths: ['a.ts'], reason: 'r' });
    expect(output).toContain('Reading the failing test before deciding.');
  });

  it('keeps the max_tokens chain behind the last message when the result has no text', () => {
    const { text } = replay([
      ...mainLoopMessage('msg_cut', '## Spec\n\nThe first half, cut mid-', 'max_tokens'),
      ...mainLoopMessage('msg_rest', 'sentence and the rest.', 'end_turn'),
      JSON.stringify({ type: 'result', result: '' }),
    ]);

    expect(text).toBe('## Spec\n\nThe first half, cut mid-sentence and the rest.');
  });

  it('takes the last message that had text when the turn ends on one without any', () => {
    const verdict = 'VERDICT: widen a.ts — r';
    const { text } = replay([
      ...mainLoopMessage('msg_narration', 'Reading the failing test before deciding.', 'tool_use'),
      ...mainLoopMessage('msg_verdict', verdict, 'tool_use'),
      streamEvent({ type: 'message_start', message: { id: 'msg_empty', content: [] } }),
      streamEvent({ type: 'message_delta', delta: { stop_reason: 'end_turn' } }),
      streamEvent({ type: 'message_stop' }),
      JSON.stringify({ type: 'result', result: '' }),
    ]);

    expect(text).toBe(verdict);
  });

  // claude-code answers `max_tokens` with "Output token limit hit. Resume directly" and a new
  // message that has every tool, so the continuation of a cut document can call one.
  it('carries a max_tokens chain across a tool call its continuation makes', () => {
    const last = '### Verdict\npass';
    const { text } = replay([
      ...mainLoopMessage('msg_narration', 'Reading the diff first.', 'tool_use'),
      ...mainLoopMessage('msg_cut', '## Review\n\nCriteria one, cut mid-', 'max_tokens'),
      ...mainLoopMessage('msg_resume', 'sentence; criteria two.', 'tool_use'),
      ...mainLoopMessage('msg_last', last, 'end_turn'),
      JSON.stringify({ type: 'result', result: last }),
    ]);

    expect(text).toBe(
      '## Review\n\nCriteria one, cut mid-sentence; criteria two.\n\n### Verdict\npass',
    );
    expect(parseFinalReview(text).verdict).toBe('pass');
  });

  it('closes the chain on end_turn so a later turn does not carry it', () => {
    const { text } = replay([
      ...mainLoopMessage('msg_cut', 'first turn, cut', 'max_tokens'),
      ...mainLoopMessage('msg_end', ' and ended.', 'end_turn'),
      ...mainLoopMessage('msg_next', 'Next turn.', 'end_turn'),
      JSON.stringify({ type: 'result', result: 'Next turn.' }),
    ]);

    expect(text).toBe('Next turn.');
  });
});

describe('Claude stream text budget', () => {
  function record(lines: readonly string[]): { events: RunnerCallEvent[]; finish: () => unknown } {
    const events: RunnerCallEvent[] = [];
    const { state, handleLine } = createStreamHandler({
      context,
      onOutput: () => {},
      onCallEvent: (event) => events.push(event),
    });
    for (const line of lines) handleLine(line);
    return { events, finish: () => finishClaudeStream(state) };
  }

  const textLimitWarnings = (events: readonly RunnerCallEvent[]) =>
    events.filter(
      (event) => event.type === 'call_warning' && event.warning.code.endsWith('_text_limit'),
    );

  it('does not warn about narration past the budget when the final text fits', () => {
    const verdict = 'VERDICT: brief — r';
    const { events, finish } = record([
      ...mainLoopMessage('msg_narration', 'n'.repeat(RUNNER_CALL_OUTPUT_MAX_BYTES + 1), 'tool_use'),
      ...mainLoopMessage('msg_verdict', verdict, 'end_turn'),
      JSON.stringify({ type: 'result', result: verdict }),
    ]);

    expect(finish()).toMatchObject({ status: 'completed', text: verdict, warnings: [] });
    expect(textLimitWarnings(events)).toEqual([]);
  });

  it('warns once when the text the call ends with was cut', () => {
    const { events, finish } = record([
      streamEvent({ type: 'message_start', message: { id: 'msg_long', content: [] } }),
      textDelta('x'.repeat(RUNNER_CALL_OUTPUT_MAX_BYTES + 1)),
    ]);

    expect(finish).toThrow('Claude runner call truncated');
    expect(textLimitWarnings(events)).toEqual([
      expect.objectContaining({
        warning: expect.objectContaining({ code: 'runner_call_text_limit' }),
      }),
    ]);
  });
});
