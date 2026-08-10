import { describe, expect, it } from 'vitest';
import {
  CLI_CONFORMANCE_CANDIDATES,
  claudeCodeImplementerAdapter,
  claudeCodePlannerAdapter,
  claudeProtocolEvents,
} from './claude-code.js';
import { CLI_TOOL_CATALOG } from '../../../core/runners/cli-tool-catalog.js';

describe('Claude Code role adapters', () => {
  it('exports planner then implementer conformance candidates with stable hashes', () => {
    expect(CLI_CONFORMANCE_CANDIDATES).toHaveLength(2);
    expect(CLI_CONFORMANCE_CANDIDATES.map((candidate) => candidate.role)).toEqual([
      'planner',
      'implementer',
    ]);
    for (const candidate of CLI_CONFORMANCE_CANDIDATES) {
      expect(candidate.id).toBe('claude-code');
      expect(candidate.rawContract.id).toBe(candidate.id);
      expect(candidate.rawContract.role).toBe(candidate.role);
      expect(candidate.contractSha256).toMatch(/^[a-f0-9]{64}$/);
      expect(candidate.adapter.role).toBe(candidate.role);
      expect(candidate.adapter.descriptor).toBe(CLI_TOOL_CATALOG['claude-code']);
    }
    expect(CLI_CONFORMANCE_CANDIDATES[0]?.contractSha256).not.toBe(
      CLI_CONFORMANCE_CANDIDATES[1]?.contractSha256,
    );
  });

  it('keeps the lossless stdin and structured-terminal contracts explicit', () => {
    expect(claudeCodePlannerAdapter.promptTransport).toEqual({ kind: 'stdin' });
    expect(claudeCodeImplementerAdapter.promptTransport).toEqual({ kind: 'stdin' });
    expect(claudeCodePlannerAdapter.outputContract).toEqual({
      kind: 'structured-terminal',
      terminalEvent: 'required',
    });
    expect(claudeCodeImplementerAdapter.outputContract).toEqual({
      kind: 'structured-terminal',
      terminalEvent: 'required',
    });
    expect(claudeCodePlannerAdapter.probe.version.command).toEqual(['claude', '--version']);
    expect(claudeCodePlannerAdapter.probe.auth.command).toEqual(['claude', 'auth']);
  });

  it('preserves Claude planner session/model/effort placement and implementer permissions', () => {
    const plannerArgs = claudeCodePlannerAdapter.buildArgs({
      prompt: '<brief>',
      model: 'claude-sonnet-4-6',
      projectDir: '/project',
      configuredArgs: ['--label', 'fixture'],
      mode: 'plan',
      sessionId: 'session-1',
      effort: 'high',
    });
    expect(plannerArgs).toEqual([
      '-p',
      '--output-format',
      'stream-json',
      '--verbose',
      '--include-partial-messages',
      '--model',
      'claude-sonnet-4-6',
      '--effort',
      'high',
      '--resume',
      'session-1',
      '--label',
      'fixture',
    ]);
    const plannerBase = plannerArgs.slice(0, -2);
    expect(claudeCodePlannerAdapter.validateArgs(plannerArgs, plannerBase)).toEqual({
      valid: true,
    });
    expect(
      claudeCodePlannerAdapter.validateArgs([...plannerArgs, '--model', 'other'], plannerBase),
    ).toEqual({ valid: false, conflicts: ['--model'] });

    const implementerArgs = claudeCodeImplementerAdapter.buildArgs({
      prompt: '<brief>',
      model: undefined,
      projectDir: '/project',
      configuredArgs: ['--label', 'fixture'],
    });
    expect(implementerArgs).toEqual([
      '-p',
      '--output-format',
      'stream-json',
      '--verbose',
      '--include-partial-messages',
      '--permission-mode',
      'acceptEdits',
      '--label',
      'fixture',
    ]);
    const implementerBase = implementerArgs.slice(0, -2);
    expect(claudeCodeImplementerAdapter.validateArgs(implementerArgs, implementerBase)).toEqual({
      valid: true,
    });
    expect(
      claudeCodeImplementerAdapter.validateArgs(
        [...implementerArgs, '--permission-mode', 'skip'],
        implementerBase,
      ),
    ).toEqual({ valid: false, conflicts: ['--permission-mode'] });
  });

  it('never re-sends a consumed session id: fresh calls carry no session flag, continuations resume', () => {
    const common = {
      prompt: '<brief>',
      model: undefined,
      projectDir: '/project',
      configuredArgs: [],
      mode: 'plan',
      effort: undefined,
    } as const;
    const firstCall = claudeCodePlannerAdapter.buildArgs({ ...common, sessionId: null });
    const capturedId = '0a3443ac-432e-40c8-bdf9-29859130257f';
    const retryCall = claudeCodePlannerAdapter.buildArgs({ ...common, sessionId: capturedId });

    expect(firstCall).not.toContain('--session-id');
    expect(firstCall).not.toContain('--resume');
    expect(retryCall).not.toContain('--session-id');
    expect(retryCall.slice(retryCall.indexOf('--resume'))).toEqual(['--resume', capturedId]);
    expect(retryCall).not.toEqual(firstCall);
  });
});

describe('Claude Code stream protocol adapter', () => {
  it('projects assistant/session/usage records and a required terminal result', () => {
    const events = claudeProtocolEvents(
      JSON.stringify({
        type: 'assistant',
        session_id: 'session-2',
        message: { content: [{ type: 'text', text: 'hello' }] },
      }),
    );
    expect(events).toEqual([
      { type: 'session', nativeSessionId: 'session-2' },
      { type: 'text', channel: 'assistant', text: 'hello', semantics: 'final' },
    ]);

    const terminal = claudeProtocolEvents(
      JSON.stringify({
        type: 'result',
        session_id: 'session-2',
        result: 'hello',
        usage: { input_tokens: 2, output_tokens: 1 },
      }),
    );
    expect(terminal.at(-1)).toMatchObject({
      type: 'result',
      status: 'completed',
      text: 'hello',
      nativeSessionId: 'session-2',
      error: null,
      partial: false,
    });
    expect(terminal).toContainEqual({
      type: 'usage',
      usage: { inputTokens: 2, outputTokens: 1 },
      semantics: 'final',
    });
  });

  it('streams a partial message once: the assistant record restates it, never appends again', () => {
    const deltas = ['returning `a', ' - b`'];
    const message = deltas.join('');
    const lines = [
      ...deltas.map((text) =>
        JSON.stringify({
          type: 'stream_event',
          session_id: 'session-3',
          event: { type: 'content_block_delta', delta: { type: 'text_delta', text } },
        }),
      ),
      JSON.stringify({
        type: 'assistant',
        session_id: 'session-3',
        message: { content: [{ type: 'text', text: message }] },
      }),
    ];
    const textEvents = lines
      .flatMap((line) => claudeProtocolEvents(line))
      .filter((event) => event.type === 'text');

    const appended = textEvents
      .filter((event) => event.semantics !== 'final')
      .map((event) => event.text)
      .join('');
    expect(appended).toBe(message);
    expect(textEvents.at(-1)).toEqual({
      type: 'text',
      channel: 'assistant',
      text: message,
      semantics: 'final',
    });
  });

  it('retains explicit failure terminals and bounded parser warnings', () => {
    const failure = claudeProtocolEvents(
      JSON.stringify({ type: 'result', is_error: true, result: 'request failed' }),
    );
    expect(failure.at(-1)).toMatchObject({
      type: 'result',
      status: 'failed',
      error: { code: 'runner_result_error', message: 'request failed' },
      partial: true,
    });

    const malformed = claudeProtocolEvents('{not-json');
    expect(malformed).toHaveLength(1);
    expect(malformed[0]).toMatchObject({
      type: 'warning',
      code: 'malformed_stream_json',
    });
  });
});
