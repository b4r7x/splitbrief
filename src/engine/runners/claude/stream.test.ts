import { describe, expect, it } from 'vitest';
import { finishClaudeStream, createStreamHandler, interruptedError } from './stream.js';
import type { RunnerCallContext, RunnerCallEvent } from '../../calls/types.js';

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
