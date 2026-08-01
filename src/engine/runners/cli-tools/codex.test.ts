import { describe, expect, it } from 'vitest';
import {
  CLI_CONFORMANCE_CANDIDATES,
  codexImplementerAdapter,
  codexPlannerAdapter,
  codexProtocolEvents,
} from './codex.js';
import { CLI_TOOL_CATALOG } from '../../../core/runners/cli-tool-catalog.js';

const PROMPT = '<PROMPT>';

function terminalInput(
  adapter: typeof codexPlannerAdapter,
  events: ReturnType<typeof codexProtocolEvents>,
) {
  return adapter.terminal({
    outputContract: adapter.outputContract,
    events,
    stdout: '',
    stderr: '',
    exitCode: 0,
    signal: null,
  });
}

describe('Codex role adapters', () => {
  it('exports planner then implementer candidates with matching canonical hashes', () => {
    expect(CLI_CONFORMANCE_CANDIDATES).toHaveLength(2);
    expect(CLI_CONFORMANCE_CANDIDATES.map((candidate) => candidate.role)).toEqual([
      'planner',
      'implementer',
    ]);
    for (const candidate of CLI_CONFORMANCE_CANDIDATES) {
      expect(candidate.id).toBe('codex');
      expect(candidate.rawContract.id).toBe(candidate.id);
      expect(candidate.rawContract.role).toBe(candidate.role);
      expect(candidate.rawContract.promptTransport).toBe('argv');
      expect(candidate.rawContract.rawInvocation.filter((arg) => arg === PROMPT)).toHaveLength(1);
      expect(candidate.contractSha256).toMatch(/^[a-f0-9]{64}$/);
      expect(candidate.adapter.role).toBe(candidate.role);
      expect(candidate.adapter.descriptor).toBe(CLI_TOOL_CATALOG.codex);
    }
    expect(CLI_CONFORMANCE_CANDIDATES[0]?.contractSha256).not.toBe(
      CLI_CONFORMANCE_CANDIDATES[1]?.contractSha256,
    );
  });

  it('keeps argv and terminal contracts explicit for both roles', () => {
    expect(codexPlannerAdapter.promptTransport).toEqual({
      kind: 'argv',
      maxBytes: 120_000,
      placement: 'positional',
    });
    expect(codexImplementerAdapter.promptTransport).toEqual({
      kind: 'argv',
      maxBytes: 120_000,
      placement: 'positional',
    });
    expect(codexPlannerAdapter.outputContract).toEqual({
      kind: 'structured-terminal',
      terminalEvent: 'required',
    });
    expect(codexImplementerAdapter.outputContract).toEqual({
      kind: 'structured-terminal',
      terminalEvent: 'required',
    });
    expect(codexPlannerAdapter.probe.version.command).toEqual(['codex', '--version']);
    expect(codexPlannerAdapter.probe.auth.command).toEqual(['codex', 'auth']);
  });

  it('preserves planner exec/resume, model, cd, escalation, and configured argument order', () => {
    const resumed = codexPlannerAdapter.buildArgs({
      prompt: PROMPT,
      model: 'gpt-5',
      projectDir: '/project',
      configuredArgs: ['--label', 'fixture'],
      mode: 'plan',
      sessionId: 'session-1',
      effort: 'high',
    });
    expect(resumed).toEqual([
      'exec',
      'resume',
      '--model',
      'gpt-5',
      '--json',
      'session-1',
      PROMPT,
      '--label',
      'fixture',
    ]);
    expect(resumed).not.toContain('--reasoning-effort');
    expect(codexPlannerAdapter.validateArgs(resumed, resumed.slice(0, -2))).toEqual({
      valid: true,
    });

    const readOnly = codexPlannerAdapter.buildArgs({
      prompt: PROMPT,
      model: 'gpt-5',
      projectDir: '/project',
      configuredArgs: [],
      mode: 'plan',
      sessionId: null,
      effort: undefined,
    });
    expect(readOnly).toEqual(['--model', 'gpt-5', 'exec', '--json', '--cd', '/project', PROMPT]);
    expect(readOnly).not.toContain('--sandbox');

    const escalation = codexPlannerAdapter.buildArgs({
      prompt: PROMPT,
      model: undefined,
      projectDir: '/project',
      configuredArgs: [],
      mode: 'escalate',
      sessionId: 'session-1',
      effort: undefined,
    });
    expect(escalation).toEqual([
      'exec',
      '--json',
      '--sandbox',
      'workspace-write',
      '--skip-git-repo-check',
      '--cd',
      '/project',
      PROMPT,
    ]);
  });

  it('preserves implementer workspace-write, cd, model, and prompt placement', () => {
    const args = codexImplementerAdapter.buildArgs({
      prompt: PROMPT,
      model: 'gpt-5.2',
      projectDir: '/staged',
      configuredArgs: ['--label', 'fixture'],
    });
    expect(args).toEqual([
      '--model',
      'gpt-5.2',
      'exec',
      '--json',
      '--sandbox',
      'workspace-write',
      '--skip-git-repo-check',
      '--cd',
      '/staged',
      PROMPT,
      '--label',
      'fixture',
    ]);
    const base = args.slice(0, -2);
    expect(codexImplementerAdapter.validateArgs(args, base)).toEqual({ valid: true });
    expect(codexImplementerAdapter.validateArgs([...args, '--sandbox', 'danger'], base)).toEqual({
      valid: false,
      conflicts: ['--sandbox'],
    });
    expect(codexImplementerAdapter.validateArgs([...args, 'prefix-<PROMPT>'], base)).toEqual({
      valid: false,
      conflicts: ['prompt-transport'],
    });
  });
});

describe('Codex JSONL protocol adapter', () => {
  it('projects session, assistant text, usage, and a required terminal result', () => {
    const events = [
      ...codexProtocolEvents(JSON.stringify({ type: 'thread.started', thread_id: 'session-2' })),
      ...codexProtocolEvents(
        JSON.stringify({
          type: 'item.completed',
          item: { type: 'agent_message', text: 'hello' },
        }),
      ),
      ...codexProtocolEvents(
        JSON.stringify({
          type: 'turn.completed',
          usage: { input_tokens: 2, output_tokens: 1 },
        }),
      ),
    ];
    expect(events).toContainEqual({ type: 'session', nativeSessionId: 'session-2' });
    expect(events).toContainEqual({ type: 'text', channel: 'assistant', text: 'hello' });
    expect(events).toContainEqual({
      type: 'usage',
      usage: { inputTokens: 2, outputTokens: 1 },
      semantics: 'final',
    });
    expect(terminalInput(codexPlannerAdapter, events)).toMatchObject({
      type: 'result',
      status: 'completed',
      nativeSessionId: 'session-2',
      error: null,
      partial: false,
    });
  });

  it('fails explicit turn.failed and malformed required records', () => {
    const failed = codexProtocolEvents(JSON.stringify({ type: 'turn.failed' }));
    expect(terminalInput(codexPlannerAdapter, failed)).toMatchObject({
      status: 'failed',
      error: { code: 'codex-turn-failed' },
    });

    const malformed = codexProtocolEvents('{not-json');
    expect(terminalInput(codexPlannerAdapter, malformed)).toMatchObject({
      status: 'failed',
      error: { code: 'malformed-codex-json' },
    });

    const malformedRequired = codexProtocolEvents(
      JSON.stringify({ type: 'thread.started', thread_id: 42 }),
    );
    expect(terminalInput(codexPlannerAdapter, malformedRequired)).toMatchObject({
      status: 'failed',
      error: { code: 'malformed-codex-record' },
    });
  });

  it('requires a terminal event instead of treating a partial stream as success', () => {
    const events = codexProtocolEvents(
      JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'partial' } }),
    );
    expect(() => terminalInput(codexPlannerAdapter, events)).toThrow(
      'Codex output ended without a terminal result',
    );
  });

  it('retains unknown additive records as bounded warnings', () => {
    expect(codexProtocolEvents(JSON.stringify({ type: 'future.event', id: 'fixture' }))).toEqual([
      { type: 'warning', code: 'unknown-codex-record', message: 'Unknown Codex record' },
    ]);
  });
});
