import { describe, expect, it } from 'vitest';
import { CLI_TOOL_CATALOG } from '../../../core/runners/cli-tool-catalog.js';
import {
  CLI_CONFORMANCE_CANDIDATES,
  opencodeImplementerAdapter,
  opencodePlannerAdapter,
  opencodePromptArgs,
  opencodeProtocolEvents,
} from './opencode.js';

const PROMPT = '<PROMPT>';

describe('OpenCode role adapters', () => {
  it('exports planner then implementer candidates with matching canonical hashes', () => {
    expect(CLI_CONFORMANCE_CANDIDATES).toHaveLength(2);
    expect(CLI_CONFORMANCE_CANDIDATES.map((candidate) => candidate.role)).toEqual([
      'planner',
      'implementer',
    ]);
    for (const candidate of CLI_CONFORMANCE_CANDIDATES) {
      expect(candidate.id).toBe('opencode');
      expect(candidate.rawContract.id).toBe(candidate.id);
      expect(candidate.rawContract.role).toBe(candidate.role);
      expect(candidate.rawContract.rawInvocation.filter((arg) => arg === PROMPT)).toHaveLength(1);
      expect(candidate.contractSha256).toMatch(/^[a-f0-9]{64}$/);
      expect(candidate.adapter.role).toBe(candidate.role);
      expect(candidate.adapter.descriptor).toBe(CLI_TOOL_CATALOG.opencode);
      // Activation requires the complete receipt: the declared raw terminal is
      // the process exit, and the adapter binds the same stdout-final contract.
      expect(candidate.rawContract.expectedRawTerminal).toBe('process-exit');
      expect(candidate.adapter.outputContract).toEqual({
        kind: 'text-exit',
        successfulExitCodes: [0],
      });
    }
    const implementerRaw = CLI_CONFORMANCE_CANDIDATES[1]?.rawContract.rawInvocation ?? [];
    expect(implementerRaw.slice(0, 5)).toEqual(['run', '--format', 'json', '--agent', 'build']);
    expect(CLI_CONFORMANCE_CANDIDATES[0]?.contractSha256).not.toBe(
      CLI_CONFORMANCE_CANDIDATES[1]?.contractSha256,
    );
  });

  it('keeps JSON argv, process-exit completion, and bounded probes explicit', () => {
    for (const adapter of [opencodePlannerAdapter, opencodeImplementerAdapter]) {
      expect(adapter.promptTransport).toEqual({
        kind: 'argv',
        maxBytes: 120_000,
        placement: 'positional',
      });
      expect(adapter.outputContract).toEqual({
        kind: 'text-exit',
        successfulExitCodes: [0],
      });
      expect(adapter.probe.version).toEqual({
        command: ['opencode', '--version'],
        cwd: 'neutral',
        timeoutMs: 5_000,
        maxOutputBytes: 4_096,
      });
      expect(adapter.probe.auth.timeoutMs).toBe(5_000);
    }
  });

  it('preserves planner agent, model placement, implementer build role, and configured order', () => {
    expect(
      opencodePromptArgs({ role: 'planner', model: undefined, configuredArgs: ['--label', 'one'] }),
    ).toEqual(['run', '--format', 'json', '--agent', 'plan', PROMPT, '--label', 'one']);
    expect(
      opencodePromptArgs({ role: 'planner', model: 'openai/gpt-5', configuredArgs: [] }),
    ).toEqual(['run', '--model', 'openai/gpt-5', '--format', 'json', '--agent', 'plan', PROMPT]);
    expect(
      opencodePromptArgs({
        role: 'implementer',
        model: 'anthropic/claude-sonnet',
        configuredArgs: [],
      }),
    ).toEqual([
      'run',
      '--model',
      'anthropic/claude-sonnet',
      '--format',
      'json',
      '--agent',
      'build',
      PROMPT,
    ]);
    const plannerBase = opencodePromptArgs({ role: 'planner' });
    const implementerBase = opencodePromptArgs({ role: 'implementer' });
    expect(opencodePlannerAdapter.validateArgs(plannerBase, plannerBase)).toEqual({ valid: true });
    expect(
      opencodeImplementerAdapter.validateArgs(
        [...implementerBase, '--format', 'text'],
        implementerBase,
      ),
    ).toEqual({ valid: false, conflicts: ['--format'] });
  });

  it('pins the effective role on every vector: default-role, fallback, and subagent runs fail', () => {
    const plannerBase = opencodePromptArgs({ role: 'planner' });
    const implementerBase = opencodePromptArgs({ role: 'implementer' });
    const escalationArgs = opencodePromptArgs({ role: 'planner', mode: 'escalate' });

    expect(plannerBase).toContain('--agent');
    expect(plannerBase[plannerBase.indexOf('--agent') + 1]).toBe('plan');
    expect(implementerBase).toContain('--agent');
    expect(implementerBase[implementerBase.indexOf('--agent') + 1]).toBe('build');
    expect(escalationArgs).toContain('--agent');
    expect(escalationArgs[escalationArgs.indexOf('--agent') + 1]).toBe('build');

    for (const base of [plannerBase, implementerBase]) {
      expect(
        opencodeImplementerAdapter.validateArgs([...base, '--agent', 'subagent'], base),
      ).toEqual({ valid: false, conflicts: ['--agent'] });
      expect(opencodeImplementerAdapter.validateArgs([...base, '--agent=plan'], base)).toEqual({
        valid: false,
        conflicts: ['--agent'],
      });
      expect(
        opencodeImplementerAdapter.validateArgs([...base, '--agent', 'default'], base),
      ).toEqual({
        valid: false,
        conflicts: ['--agent'],
      });
    }
  });

  it('overrides read-only agent defaults with the verified build agent for full escalation', () => {
    const input = {
      prompt: PROMPT,
      model: undefined,
      projectDir: '',
      configuredArgs: [],
      sessionId: null,
      effort: undefined,
    };

    expect(opencodePlannerAdapter.buildArgs({ ...input, mode: 'plan' })).toEqual([
      'run',
      '--format',
      'json',
      '--agent',
      'plan',
      PROMPT,
    ]);
    const escalationArgs = opencodePlannerAdapter.buildArgs({ ...input, mode: 'escalate' });
    expect(escalationArgs).toEqual(['run', '--format', 'json', '--agent', 'build', PROMPT]);
    expect(
      opencodePlannerAdapter.validateArgs(
        opencodePlannerAdapter.buildArgs({
          ...input,
          mode: 'escalate',
          configuredArgs: ['--agent', 'plan'],
        }),
        escalationArgs,
      ),
    ).toEqual({ valid: false, conflicts: ['--agent', 'plan'] });
  });

  it('rejects prompt placeholders, duplicate sentinels, and reordered protected args', () => {
    const base = opencodePromptArgs({ role: 'implementer' });
    expect(opencodeImplementerAdapter.validateArgs([...base, 'prefix-<PROMPT>'], base)).toEqual({
      valid: false,
      conflicts: ['prompt-transport'],
    });
    expect(opencodeImplementerAdapter.validateArgs([...base, PROMPT], base)).toEqual({
      valid: false,
      conflicts: ['prompt-transport'],
    });
    expect(opencodeImplementerAdapter.validateArgs([PROMPT, ...base], base)).toEqual({
      valid: false,
      conflicts: ['argument-order', 'prompt-transport'],
    });
    expect(opencodeImplementerAdapter.validateArgs([...base, '-m', 'other'], base)).toEqual({
      valid: false,
      conflicts: ['-m'],
    });
    expect(opencodeImplementerAdapter.validateArgs([...base, '-mPROMPT'], base)).toEqual({
      valid: false,
      conflicts: ['-m'],
    });
  });
});

describe('OpenCode JSON envelope adapter', () => {
  it('projects text, session, usage, and tool envelopes', () => {
    const text = opencodeProtocolEvents(
      JSON.stringify({
        type: 'text',
        sessionID: 'ses-open',
        part: { type: 'text', text: 'hello' },
      }),
    );
    expect(text).toEqual([
      { type: 'session', nativeSessionId: 'ses-open' },
      { type: 'text', channel: 'assistant', text: 'hello' },
    ]);

    const usage = opencodeProtocolEvents(
      JSON.stringify({
        type: 'step_finish',
        sessionID: 'ses-open',
        part: { type: 'step-finish', tokens: { input: 5, output: 2, reasoning: 1 } },
      }),
    );
    expect(usage).toContainEqual({
      type: 'usage',
      usage: { inputTokens: 5, outputTokens: 2, reasoningTokens: 1 },
      semantics: 'delta',
    });

    expect(
      opencodeProtocolEvents(
        JSON.stringify({
          type: 'tool_result',
          sessionID: 'ses-open',
          part: {
            type: 'tool',
            id: 'tool-1',
            name: 'read',
            input: { path: 'src/a.ts' },
            output: 'ok',
          },
        }),
      ),
    ).toContainEqual({
      type: 'tool-use',
      id: 'tool-1',
      name: 'read',
      input: { path: 'src/a.ts' },
      output: 'ok',
    });
  });

  it('preserves bounded parser warnings and typed error terminals', () => {
    expect(opencodeProtocolEvents('{not-json')).toEqual([
      expect.objectContaining({ type: 'warning', code: 'malformed_opencode' }),
    ]);
    expect(
      opencodeProtocolEvents(JSON.stringify({ type: 'error', sessionID: 'ses-open' })),
    ).toEqual([
      {
        type: 'result',
        status: 'failed',
        text: '',
        usage: null,
        nativeSessionId: 'ses-open',
        error: { code: 'opencode-error', message: 'OpenCode reported an error' },
        partial: true,
      },
    ]);
  });

  it('returns the exact final group after the last tool call with accumulated usage and session', () => {
    const events = [
      ...opencodeProtocolEvents(
        JSON.stringify({
          type: 'text',
          sessionID: 'ses-final',
          part: { type: 'text', text: 'earlier draft' },
        }),
      ),
      ...opencodeProtocolEvents(
        JSON.stringify({
          type: 'tool_result',
          sessionID: 'ses-final',
          part: { type: 'tool', id: 'tool-1', name: 'read', input: { path: 'src/a.ts' } },
        }),
      ),
      ...opencodeProtocolEvents(
        JSON.stringify({
          type: 'text',
          sessionID: 'ses-final',
          part: { type: 'text', text: 'final message' },
        }),
      ),
      ...opencodeProtocolEvents(
        JSON.stringify({
          type: 'step_finish',
          sessionID: 'ses-final',
          part: { type: 'step-finish', tokens: { input: 5, output: 3, reasoning: 1 } },
        }),
      ),
    ];
    const terminal = opencodePlannerAdapter.terminal({
      outputContract: opencodePlannerAdapter.outputContract,
      events,
      stdout: '',
      stderr: '',
      exitCode: 0,
      signal: null,
    });
    expect(terminal).toEqual({
      type: 'result',
      status: 'completed',
      text: 'final message',
      usage: { inputTokens: 5, outputTokens: 3, reasoningTokens: 1 },
      nativeSessionId: 'ses-final',
      error: null,
      partial: false,
    });
  });

  it('keeps the implementer terminal on the same exact final group', () => {
    const events = [
      ...opencodeProtocolEvents(
        JSON.stringify({
          type: 'text',
          sessionID: 'ses-impl',
          part: { type: 'text', text: 'edit applied' },
        }),
      ),
    ];
    expect(
      opencodeImplementerAdapter.terminal({
        outputContract: opencodeImplementerAdapter.outputContract,
        events,
        stdout: '',
        stderr: '',
        exitCode: 0,
        signal: null,
      }),
    ).toEqual({
      type: 'result',
      status: 'completed',
      text: 'edit applied',
      usage: null,
      nativeSessionId: 'ses-impl',
      error: null,
      partial: false,
    });
  });
});
