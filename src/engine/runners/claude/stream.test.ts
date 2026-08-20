import { describe, expect, it } from 'vitest';
import { finishClaudeStream, createStreamHandler, interruptedError } from './stream.js';
import { TASK_BRIEF_COMPILER_POLICY } from '../../../core/schemas/task-compilation.js';
import type { RunnerCallContext, RunnerCallEvent } from '../../calls/types.js';

const context: RunnerCallContext = {
  callId: 'claude-redaction-test',
  role: 'planner',
  backendKind: 'cli',
  runnerName: 'claude',
};

function envelopeContext(): RunnerCallContext {
  return {
    ...context,
    callId: 'claude-envelope-stream-test',
    envelope: {
      version: 1,
      promptBytes: 512,
      inputTokensUpperBound: 512,
      requestedOutputTokens: TASK_BRIEF_COMPILER_POLICY.requestedOutputTokens,
      outputTokensUpperBound: TASK_BRIEF_COMPILER_POLICY.maxNormalizedOutputBytes,
      maxNormalizedOutputBytes: TASK_BRIEF_COMPILER_POLICY.maxNormalizedOutputBytes,
      maxDeclaredArtifactBytes: TASK_BRIEF_COMPILER_POLICY.maxDeclaredArtifactBytes,
      maxRawProtocolBytes: TASK_BRIEF_COMPILER_POLICY.maxRawProtocolBytes,
      maxStderrBytes: TASK_BRIEF_COMPILER_POLICY.maxStderrBytes,
      deadlineMs: TASK_BRIEF_COMPILER_POLICY.deadlineMs,
      idleTimeoutMs: TASK_BRIEF_COMPILER_POLICY.idleTimeoutMs,
    },
  };
}

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
    expect(result.text).not.toContain('draft text');
  });

  it('fails an empty final response under a compiler envelope instead of falling back to partials', () => {
    const events: RunnerCallEvent[] = [];
    const { state, handleLine } = createStreamHandler({
      context: envelopeContext(),
      onOutput: () => {},
      onCallEvent: (event) => events.push(event),
    });

    handleLine(
      JSON.stringify({
        type: 'assistant',
        message: { content: [{ type: 'text', text: 'partial text' }] },
      }),
    );
    handleLine(JSON.stringify({ type: 'result' }));

    expect(() => finishClaudeStream(state)).toThrow('no final response text');
    const errors = events.filter(
      (event): event is Extract<RunnerCallEvent, { type: 'call_error' }> =>
        event.type === 'call_error',
    );
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({
      status: 'failed',
      error: { code: 'task_compiler_final_response_missing' },
      partial: true,
    });
  });

  it('redacts credentials from partial text when a compiler-enveloped call fails its final response', () => {
    const credential = 'opaque-claude-envelope-stream-canary-8c41e2f9';
    const events: RunnerCallEvent[] = [];
    const { state, handleLine } = createStreamHandler({
      context: envelopeContext(),
      credentialValues: [credential],
      onOutput: () => {},
      onCallEvent: (event) => events.push(event),
    });

    handleLine(
      JSON.stringify({
        type: 'assistant',
        message: { content: [{ type: 'text', text: `partial with ${credential}` }] },
      }),
    );
    handleLine(JSON.stringify({ type: 'result' }));

    expect(() => finishClaudeStream(state)).toThrow('no final response text');
    const persisted = JSON.stringify(events);
    expect(persisted).not.toContain(credential);
    expect(persisted).toContain('***REDACTED***');
  });
});
