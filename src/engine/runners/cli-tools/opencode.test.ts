import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CLI_TOOL_CATALOG } from '../../../core/runners/cli-tool-catalog.js';
import {
  CLI_CONFORMANCE_CANDIDATES,
  opencodeImplementerAdapter,
  opencodePlannerAdapter,
  opencodeProtocolEvents,
} from './opencode.js';
import { CLI_PROMPT_SENTINEL } from './candidate-contract.js';

const PROMPT = CLI_PROMPT_SENTINEL;
const PROJECT_DIR = process.cwd();
const STREAM_JSON_FIXTURE = join(
  import.meta.dirname,
  '../../../../testing/fixtures/opencode/stream-json.ndjson',
);

function plannerArgs(
  model: string | undefined,
  mode: 'plan' | 'escalate',
  configuredArgs: readonly string[],
) {
  return opencodePlannerAdapter.buildArgs({
    prompt: PROMPT,
    model,
    projectDir: PROJECT_DIR,
    configuredArgs,
    mode,
    sessionId: null,
    effort: undefined,
  });
}

function implementerArgs(model: string | undefined, configuredArgs: readonly string[]) {
  return opencodeImplementerAdapter.buildArgs({
    prompt: PROMPT,
    model,
    projectDir: PROJECT_DIR,
    configuredArgs,
  });
}

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

  it('runs on a private server from 2.0.0 on and on the background service below it', () => {
    const planner = (installedVersion: string | undefined) =>
      opencodePlannerAdapter.buildArgs({
        prompt: PROMPT,
        model: undefined,
        projectDir: PROJECT_DIR,
        configuredArgs: [],
        mode: 'plan',
        sessionId: null,
        effort: undefined,
        installedVersion,
      });
    const implementer = (installedVersion: string | undefined) =>
      opencodeImplementerAdapter.buildArgs({
        prompt: PROMPT,
        model: undefined,
        projectDir: PROJECT_DIR,
        configuredArgs: [],
        installedVersion,
      });

    expect(planner('2.0.12')).toEqual([
      'run',
      '--standalone',
      '--format',
      'json',
      '--agent',
      'plan',
      PROMPT,
    ]);
    expect(implementer('2.0.12')).toEqual([
      'run',
      '--standalone',
      '--format',
      'json',
      '--agent',
      'build',
      PROMPT,
    ]);
    for (const release of ['1.18.15', undefined]) {
      expect(planner(release)).toEqual(['run', '--format', 'json', '--agent', 'plan', PROMPT]);
      expect(implementer(release)).toEqual(['run', '--format', 'json', '--agent', 'build', PROMPT]);
    }
    expect(
      opencodeImplementerAdapter.validateArgs({
        invocationArgs: [
          'run',
          '--standalone',
          '--format',
          'json',
          '--agent',
          'build',
          PROMPT,
          '--standalone',
        ],
        baseArgs: ['run', '--standalone', '--format', 'json', '--agent', 'build', PROMPT],
      }).valid,
    ).toBe(false);
  });

  it('preserves planner agent, model placement, implementer build role, and configured order', () => {
    expect(plannerArgs(undefined, 'plan', ['--label', 'one'])).toEqual([
      'run',
      '--format',
      'json',
      '--agent',
      'plan',
      PROMPT,
      '--label',
      'one',
    ]);
    expect(plannerArgs('openai/gpt-5', 'plan', [])).toEqual([
      'run',
      '--model',
      'openai/gpt-5',
      '--format',
      'json',
      '--agent',
      'plan',
      PROMPT,
    ]);
    expect(implementerArgs('anthropic/claude-sonnet', [])).toEqual([
      'run',
      '--model',
      'anthropic/claude-sonnet',
      '--format',
      'json',
      '--agent',
      'build',
      PROMPT,
    ]);
    const plannerBase = plannerArgs(undefined, 'plan', []);
    const implementerBase = implementerArgs(undefined, []);
    expect(
      opencodePlannerAdapter.validateArgs({ invocationArgs: plannerBase, baseArgs: plannerBase }),
    ).toEqual({ valid: true });
    expect(
      opencodeImplementerAdapter.validateArgs({
        invocationArgs: [...implementerBase, '--format', 'text'],
        baseArgs: implementerBase,
      }),
    ).toEqual({ valid: false, conflicts: ['--format'] });
  });

  it('puts the configured variant on the planner argv', () => {
    expect(
      opencodePlannerAdapter.buildArgs({
        prompt: PROMPT,
        model: 'openai/gpt-5.6-luna',
        projectDir: PROJECT_DIR,
        configuredArgs: [],
        mode: 'plan',
        sessionId: null,
        effort: undefined,
        variant: 'xhigh',
      }),
    ).toEqual([
      'run',
      '--model',
      'openai/gpt-5.6-luna',
      '--variant',
      'xhigh',
      '--format',
      'json',
      '--agent',
      'plan',
      PROMPT,
    ]);
  });

  it('puts the configured variant on the implementer argv', () => {
    expect(
      opencodeImplementerAdapter.buildArgs({
        prompt: PROMPT,
        model: 'openai/gpt-5.6-luna',
        projectDir: PROJECT_DIR,
        configuredArgs: [],
        variant: 'xhigh',
      }),
    ).toEqual([
      'run',
      '--model',
      'openai/gpt-5.6-luna',
      '--variant',
      'xhigh',
      '--format',
      'json',
      '--agent',
      'build',
      PROMPT,
    ]);
  });

  it('folds the variant into the model from 2.0.0 on, which rejects --variant', () => {
    const seat = (installedVersion: string) => ({
      prompt: PROMPT,
      model: 'opencode-go/mimo-v2.6-flash',
      projectDir: PROJECT_DIR,
      configuredArgs: [],
      variant: 'thinking',
      installedVersion,
    });
    const planner = (installedVersion: string) =>
      opencodePlannerAdapter.buildArgs({
        ...seat(installedVersion),
        mode: 'plan',
        sessionId: null,
        effort: undefined,
      });

    expect(planner('2.0.14').slice(0, 4)).toEqual([
      'run',
      '--standalone',
      '--model',
      'opencode-go/mimo-v2.6-flash#thinking',
    ]);
    expect(opencodeImplementerAdapter.buildArgs(seat('2.0.14')).slice(0, 4)).toEqual([
      'run',
      '--standalone',
      '--model',
      'opencode-go/mimo-v2.6-flash#thinking',
    ]);
    expect(planner('2.0.14')).not.toContain('--variant');
    expect(planner('1.18.32').slice(0, 5)).toEqual([
      'run',
      '--model',
      'opencode-go/mimo-v2.6-flash',
      '--variant',
      'thinking',
    ]);
    expect(opencodeImplementerAdapter.buildArgs(seat('1.18.32')).slice(0, 5)).toEqual([
      'run',
      '--model',
      'opencode-go/mimo-v2.6-flash',
      '--variant',
      'thinking',
    ]);
  });

  it('omits the flag entirely when no variant is configured', () => {
    expect(plannerArgs('openai/gpt-5.6-luna', 'plan', [])).not.toContain('--variant');
    expect(implementerArgs('openai/gpt-5.6-luna', [])).not.toContain('--variant');
  });

  it('refuses a configured --variant smuggled through args', () => {
    const base = implementerArgs('openai/gpt-5.6-luna', []);
    expect(
      opencodeImplementerAdapter.validateArgs({
        invocationArgs: [...base, '--variant', 'max'],
        baseArgs: base,
      }),
    ).toEqual({ valid: false, conflicts: ['--variant'] });
  });

  it('keeps --variant out of the declared raw contract', () => {
    expect(CLI_CONFORMANCE_CANDIDATES[0]?.rawContract.rawInvocation).toEqual([
      'run',
      '--format',
      'json',
      '--agent',
      'plan',
      PROMPT,
    ]);
    expect(CLI_CONFORMANCE_CANDIDATES[1]?.rawContract.rawInvocation).toEqual([
      'run',
      '--format',
      'json',
      '--agent',
      'build',
      PROMPT,
    ]);
  });

  it('pins the effective role on every vector: default-role, fallback, and subagent runs fail', () => {
    const plannerBase = plannerArgs(undefined, 'plan', []);
    const implementerBase = implementerArgs(undefined, []);
    const escalationArgs = plannerArgs(undefined, 'escalate', []);

    expect(plannerBase).toContain('--agent');
    expect(plannerBase[plannerBase.indexOf('--agent') + 1]).toBe('plan');
    expect(implementerBase).toContain('--agent');
    expect(implementerBase[implementerBase.indexOf('--agent') + 1]).toBe('build');
    expect(escalationArgs).toContain('--agent');
    expect(escalationArgs[escalationArgs.indexOf('--agent') + 1]).toBe('build');

    for (const [adapter, base] of [
      [opencodePlannerAdapter, plannerBase],
      [opencodeImplementerAdapter, implementerBase],
    ] as const) {
      for (const override of [['--agent', 'subagent'], ['--agent=plan'], ['--agent', 'default']]) {
        expect(
          adapter.validateArgs({ invocationArgs: [...base, ...override], baseArgs: base }),
        ).toEqual({ valid: false, conflicts: ['--agent'] });
      }
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
      opencodePlannerAdapter.validateArgs({
        invocationArgs: opencodePlannerAdapter.buildArgs({
          ...input,
          mode: 'escalate',
          configuredArgs: ['--agent', 'plan'],
        }),
        baseArgs: escalationArgs,
      }),
    ).toEqual({ valid: false, conflicts: ['--agent', 'plan'] });
  });

  it('rejects prompt placeholders, duplicate sentinels, and reordered protected args', () => {
    const base = implementerArgs(undefined, []);
    expect(
      opencodeImplementerAdapter.validateArgs({
        invocationArgs: [...base, 'prefix-<PROMPT>'],
        baseArgs: base,
      }),
    ).toEqual({
      valid: false,
      conflicts: ['prompt-transport'],
    });
    expect(
      opencodeImplementerAdapter.validateArgs({
        invocationArgs: [...base, PROMPT],
        baseArgs: base,
      }),
    ).toEqual({
      valid: false,
      conflicts: ['prompt-transport'],
    });
    expect(
      opencodeImplementerAdapter.validateArgs({
        invocationArgs: [PROMPT, ...base],
        baseArgs: base,
      }),
    ).toEqual({
      valid: false,
      conflicts: ['argument-order', 'prompt-transport'],
    });
    expect(
      opencodeImplementerAdapter.validateArgs({
        invocationArgs: [...base, '-m', 'other'],
        baseArgs: base,
      }),
    ).toEqual({
      valid: false,
      conflicts: ['-m'],
    });
    expect(
      opencodeImplementerAdapter.validateArgs({
        invocationArgs: [...base, '-mPROMPT'],
        baseArgs: base,
      }),
    ).toEqual({
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

  it('marks a running tool part as started and the captured completed part as done', () => {
    expect(
      opencodeProtocolEvents(
        JSON.stringify({
          type: 'tool_use',
          sessionID: 'ses-open',
          part: {
            type: 'tool',
            callID: 'bash_0',
            tool: 'bash',
            state: { status: 'running', input: { command: 'npm test' } },
          },
        }),
      ),
    ).toContainEqual({
      type: 'tool-use',
      stage: 'started',
      id: 'bash_0',
      name: 'bash',
      input: { command: 'npm test' },
    });

    const captured = readFileSync(STREAM_JSON_FIXTURE, 'utf8')
      .split('\n')
      .filter((line) => line.length > 0)
      .flatMap((line) => [...opencodeProtocolEvents(line)]);
    expect(captured).toContainEqual({
      type: 'tool-use',
      id: 'call_c568a8ee89a44c3dbf494d2d',
      name: 'read',
      input: { path: 'README.md' },
      output: expect.stringContaining('This is a throwaway probe repository for opencode.'),
    });
    expect(captured.some((event) => event.type === 'warning')).toBe(false);
    expect(
      opencodePlannerAdapter.terminal({
        outputContract: opencodePlannerAdapter.outputContract,
        events: captured,
        stderr: '',
        exitCode: 0,
        signal: null,
      }),
    ).toMatchObject({
      status: 'completed',
      text: 'OK',
      nativeSessionId: 'ses_f3b8e6d96ffeVsgNHwMBiToqhx',
    });
  });

  it('preserves bounded parser warnings and reads an error line as a warning with its own words', () => {
    expect(opencodeProtocolEvents('{not-json')).toEqual([
      expect.objectContaining({ type: 'warning', code: 'malformed_opencode' }),
    ]);
    expect(
      opencodeProtocolEvents(JSON.stringify({ type: 'error', sessionID: 'ses-open' })),
    ).toEqual([
      { type: 'session', nativeSessionId: 'ses-open' },
      { type: 'warning', code: 'opencode-error', message: 'OpenCode reported an error' },
    ]);
  });

  it('ends on an error line only when the stream ends after it', () => {
    const errorLine = JSON.stringify({
      type: 'error',
      sessionID: 'ses-open',
      error: { name: 'APIError', data: { message: 'Upstream stream ended', isRetryable: true } },
    });
    const finalText = JSON.stringify({
      type: 'text',
      sessionID: 'ses-open',
      part: { type: 'text', text: 'handed back' },
    });
    const usage = JSON.stringify({
      type: 'step_finish',
      sessionID: 'ses-open',
      part: { type: 'step-finish', reason: 'tool-calls', tokens: { input: 7, output: 2 } },
    });
    const terminalOf = (lines: readonly string[]) =>
      opencodeImplementerAdapter.terminal({
        outputContract: opencodeImplementerAdapter.outputContract,
        events: lines.flatMap((line) => [...opencodeProtocolEvents(line)]),
        stderr: '',
        exitCode: 0,
        signal: null,
      });

    expect(terminalOf([usage, errorLine])).toEqual({
      type: 'result',
      status: 'failed',
      text: '',
      usage: { inputTokens: 7, outputTokens: 2 },
      nativeSessionId: 'ses-open',
      error: { code: 'opencode-error', message: 'APIError: Upstream stream ended' },
      partial: true,
    });
    expect(terminalOf([usage, errorLine, finalText])).toMatchObject({
      status: 'completed',
      text: 'handed back',
      error: null,
    });
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
