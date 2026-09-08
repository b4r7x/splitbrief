import { describe, expect, it } from 'vitest';
import { CLI_COMPILER_EVIDENCE, CLI_TOOL_CATALOG } from '../../../core/runners/cli-tool-catalog.js';
import { contractSha256 } from '../../providers/candidate-contract.js';
import {
  CLI_CONFORMANCE_CANDIDATES,
  kiloImplementerAdapter,
  kiloImplementerProtocolEvents,
  kiloPlannerAdapter,
  kiloPlannerProtocolEvents,
} from './kilo-code.js';
import { CLI_PROMPT_SENTINEL } from './candidate-contract.js';

const PROMPT = CLI_PROMPT_SENTINEL;
const PROJECT_DIR = process.cwd();

function plannerArgs(
  model: string | undefined,
  mode: 'plan' | 'escalate',
  configuredArgs: readonly string[],
) {
  return kiloPlannerAdapter.buildArgs({
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
  return kiloImplementerAdapter.buildArgs({
    prompt: PROMPT,
    model,
    projectDir: PROJECT_DIR,
    configuredArgs,
  });
}

const ROLE_SEATS = [
  ['planner', kiloPlannerAdapter, plannerArgs(undefined, 'plan', []), 'plan'],
  ['implementer', kiloImplementerAdapter, implementerArgs(undefined, []), 'code'],
] as const;

const AGENT_OVERRIDE_SEATS = ROLE_SEATS.flatMap(([seat, adapter, base]) =>
  (
    [
      ['separate-value subagent', ['--agent', 'subagent']],
      ['inline plan', ['--agent=plan']],
      ['separate-value default', ['--agent', 'default']],
    ] as const
  ).map(([shape, override]) => [`${seat} ${shape}`, adapter, base, override] as const),
);

describe('Kilo Code role adapters', () => {
  it('exports planner then implementer candidates with matching hashes', () => {
    expect(CLI_CONFORMANCE_CANDIDATES).toHaveLength(2);
    expect(CLI_CONFORMANCE_CANDIDATES.map((candidate) => candidate.role)).toEqual([
      'planner',
      'implementer',
    ]);
    for (const candidate of CLI_CONFORMANCE_CANDIDATES) {
      expect(candidate.id).toBe('kilo-code');
      expect(candidate.rawContract.id).toBe(candidate.id);
      expect(candidate.rawContract.role).toBe(candidate.role);
      expect(candidate.rawContract.rawInvocation.filter((arg) => arg === PROMPT)).toHaveLength(1);
      expect(candidate.contractSha256).toMatch(/^[a-f0-9]{64}$/);
      expect(candidate.adapter.role).toBe(candidate.role);
      expect(candidate.adapter.descriptor).toBe(CLI_TOOL_CATALOG['kilo-code']);
    }
    const plannerRaw = CLI_CONFORMANCE_CANDIDATES[0]?.rawContract.rawInvocation ?? [];
    const implementerRaw = CLI_CONFORMANCE_CANDIDATES[1]?.rawContract.rawInvocation ?? [];
    expect(plannerRaw.slice(0, 6)).toEqual(['run', '--format', 'json', '--agent', 'plan', PROMPT]);
    expect(implementerRaw).toEqual(['run', '--agent', 'code', '--auto', PROMPT]);
    expect(CLI_CONFORMANCE_CANDIDATES[0]?.contractSha256).not.toBe(
      CLI_CONFORMANCE_CANDIDATES[1]?.contractSha256,
    );
  });

  it('refuses incomplete conformance with zero dispatch: the row stays conditional until a complete receipt', () => {
    // The registry row is conformance-gated: without a PASS receipt the Kilo
    // backend stays unsupported, so no Task dispatch can occur.
    expect(CLI_COMPILER_EVIDENCE['kilo-code'].state).toBe('conformance-gated');
    expect(CLI_COMPILER_EVIDENCE['kilo-code'].version).toBe('7.0.49');
    // Activation requires the complete candidate receipt: the adapter and the
    // raw contract must hash to the exact identity the harness verifies.
    for (const candidate of CLI_CONFORMANCE_CANDIDATES) {
      expect(contractSha256(candidate.rawContract)).toBe(candidate.contractSha256);
      expect(candidate.rawContract.expectedRawTerminal).toBe('process-exit');
    }
    // A hostile role override is a pre-dispatch refusal: the adapter reports
    // the conflict before any subprocess spawn.
    const implementerBase = implementerArgs(undefined, []);
    expect(
      kiloImplementerAdapter.validateArgs({
        invocationArgs: [...implementerBase, '--agent', 'plan'],
        baseArgs: implementerBase,
      }),
    ).toEqual({ valid: false, conflicts: ['--agent', 'plan'] });
  });

  it('keeps argv transport, process-exit completion, and five-second probes explicit', () => {
    for (const adapter of [kiloPlannerAdapter, kiloImplementerAdapter]) {
      expect(adapter.promptTransport).toEqual({
        kind: 'argv',
        maxBytes: 120_000,
        placement: 'positional',
      });
      expect(adapter.outputContract).toEqual({ kind: 'text-exit', successfulExitCodes: [0] });
      expect(adapter.probe).toEqual({
        version: {
          command: ['kilo', '--version'],
          cwd: 'neutral',
          timeoutMs: 5_000,
          maxOutputBytes: 4_096,
        },
        auth: {
          command: ['kilo', 'auth'],
          cwd: 'neutral',
          timeoutMs: 5_000,
          maxOutputBytes: 4_096,
        },
      });
    }
  });

  it('preserves planner read-only JSON flags, implementer code role, model placement, and order', () => {
    expect(plannerArgs(undefined, 'plan', ['--verbose'])).toEqual([
      'run',
      '--format',
      'json',
      '--agent',
      'plan',
      PROMPT,
      '--verbose',
    ]);
    expect(plannerArgs('claude-sonnet-4-6', 'plan', [])).toEqual([
      'run',
      '--model',
      'claude-sonnet-4-6',
      '--format',
      'json',
      '--agent',
      'plan',
      PROMPT,
    ]);
    expect(implementerArgs('qwen2.5-coder:7b', ['--verbose'])).toEqual([
      'run',
      '--model',
      'qwen2.5-coder:7b',
      '--agent',
      'code',
      '--auto',
      PROMPT,
      '--verbose',
    ]);
    const plannerBase = plannerArgs(undefined, 'plan', []);
    const implementerBase = implementerArgs(undefined, []);
    expect(
      kiloPlannerAdapter.validateArgs({ invocationArgs: plannerBase, baseArgs: plannerBase }),
    ).toEqual({ valid: true });
    expect(
      kiloImplementerAdapter.validateArgs({
        invocationArgs: implementerBase,
        baseArgs: implementerBase,
      }),
    ).toEqual({
      valid: true,
    });
  });

  it('sends the reasoning preset the seat configured, beside the model, on both roles', () => {
    const planner = kiloPlannerAdapter.buildArgs({
      prompt: PROMPT,
      model: 'openai/gpt-5.6',
      projectDir: PROJECT_DIR,
      configuredArgs: [],
      mode: 'plan',
      sessionId: null,
      effort: undefined,
      variant: 'max',
    });
    expect(planner).toContain('--variant');
    expect(planner[planner.indexOf('--variant') + 1]).toBe('max');

    const implementer = kiloImplementerAdapter.buildArgs({
      prompt: PROMPT,
      model: 'openai/gpt-5.6',
      projectDir: PROJECT_DIR,
      configuredArgs: [],
      variant: 'max',
    });
    expect(implementer).toContain('--variant');
    expect(implementer[implementer.indexOf('--variant') + 1]).toBe('max');
  });

  it('sends no variant flag on either role when the seat spends none', () => {
    expect(plannerArgs('openai/gpt-5.6', 'plan', [])).not.toContain('--variant');
    expect(implementerArgs('openai/gpt-5.6', [])).not.toContain('--variant');
  });

  it('refuses a configured --variant that would outrank the seat', () => {
    const base = kiloPlannerAdapter.buildArgs({
      prompt: PROMPT,
      model: 'openai/gpt-5.6',
      projectDir: PROJECT_DIR,
      configuredArgs: [],
      mode: 'plan',
      sessionId: null,
      effort: undefined,
      variant: 'max',
    });

    expect(
      kiloPlannerAdapter.validateArgs({
        invocationArgs: [...base, '--variant', 'minimal'],
        baseArgs: base,
      }),
    ).toEqual({ valid: false, conflicts: ['--variant'] });
  });

  it.each(ROLE_SEATS)(
    'pins the %s effective role in its own base vector',
    (_seat, _adapter, base, agent) => {
      expect(base).toContain('--agent');
      expect(base[base.indexOf('--agent') + 1]).toBe(agent);
    },
  );

  it.each(AGENT_OVERRIDE_SEATS)(
    'refuses a %s role override before dispatch',
    (_label, adapter, base, override) => {
      expect(
        adapter.validateArgs({ invocationArgs: [...base, ...override], baseArgs: base }),
      ).toEqual({ valid: false, conflicts: ['--agent'] });
    },
  );

  it('overrides read-only agent defaults with the verified code agent for full escalation', () => {
    const args = plannerArgs(undefined, 'escalate', []);

    expect(args).toEqual(['run', '--format', 'json', '--agent', 'code', '--auto', PROMPT]);
    expect(
      kiloPlannerAdapter.validateArgs({
        invocationArgs: plannerArgs(undefined, 'escalate', ['--agent', 'plan']),
        baseArgs: args,
      }),
    ).toEqual({ valid: false, conflicts: ['--agent', 'plan'] });
  });

  it('rejects protected flags, reordered args, and alternate prompt placeholders', () => {
    const base = implementerArgs(undefined, []);
    expect(
      kiloImplementerAdapter.validateArgs({ invocationArgs: [PROMPT, ...base], baseArgs: base }),
    ).toEqual({
      valid: false,
      conflicts: ['argument-order', 'prompt-transport'],
    });
    expect(
      kiloImplementerAdapter.validateArgs({ invocationArgs: [...base, '--auto'], baseArgs: base }),
    ).toEqual({
      valid: false,
      conflicts: ['--auto'],
    });
    expect(
      kiloImplementerAdapter.validateArgs({
        invocationArgs: [...base, 'prefix-<PROMPT>'],
        baseArgs: base,
      }),
    ).toEqual({
      valid: false,
      conflicts: ['prompt-transport'],
    });
    expect(
      kiloImplementerAdapter.validateArgs({ invocationArgs: [...base, '<OTHER>'], baseArgs: base }),
    ).toEqual({
      valid: false,
      conflicts: ['prompt-transport'],
    });
    expect(
      kiloImplementerAdapter.validateArgs({ invocationArgs: [...base, PROMPT], baseArgs: base }),
    ).toEqual({
      valid: false,
      conflicts: ['prompt-transport'],
    });
    expect(
      kiloImplementerAdapter.validateArgs({
        invocationArgs: [...base, '-m', 'other'],
        baseArgs: base,
      }),
    ).toEqual({
      valid: false,
      conflicts: ['-m'],
    });
    expect(
      kiloImplementerAdapter.validateArgs({
        invocationArgs: [...base, '-mPROMPT'],
        baseArgs: base,
      }),
    ).toEqual({
      valid: false,
      conflicts: ['-m'],
    });
  });
});

describe('Kilo Code planner JSON adapter', () => {
  it('projects text, session, usage, and tool envelopes', () => {
    expect(
      kiloPlannerProtocolEvents(
        JSON.stringify({
          type: 'text',
          sessionID: 'ses-kilo',
          part: { type: 'text', text: 'plan' },
        }),
      ),
    ).toEqual([
      { type: 'session', nativeSessionId: 'ses-kilo' },
      { type: 'text', channel: 'assistant', text: 'plan' },
    ]);
    expect(
      kiloPlannerProtocolEvents(
        JSON.stringify({
          type: 'step_finish',
          sessionID: 'ses-kilo',
          part: { type: 'step-finish', tokens: { input: 5, output: 2, reasoning: 1 } },
        }),
      ),
    ).toContainEqual({
      type: 'usage',
      usage: { inputTokens: 5, outputTokens: 2, reasoningTokens: 1 },
      semantics: 'delta',
    });
    expect(
      kiloPlannerProtocolEvents(
        JSON.stringify({
          type: 'tool_result',
          sessionID: 'ses-kilo',
          part: { type: 'tool', id: 'tool-1', name: 'read', input: { path: 'src/a.ts' } },
        }),
      ),
    ).toContainEqual({
      type: 'tool-use',
      id: 'tool-1',
      name: 'read',
      input: { path: 'src/a.ts' },
    });
  });

  it('keeps malformed and explicit error records typed and bounded', () => {
    expect(kiloPlannerProtocolEvents('{not-json')).toEqual([
      expect.objectContaining({ type: 'warning', code: 'malformed_opencode' }),
    ]);
    expect(
      kiloPlannerProtocolEvents(JSON.stringify({ type: 'error', sessionID: 'ses-kilo' })),
    ).toEqual([
      {
        type: 'result',
        status: 'failed',
        text: '',
        usage: null,
        nativeSessionId: 'ses-kilo',
        error: { code: 'kilo-code-error', message: 'Kilo Code reported an error' },
        partial: true,
      },
    ]);
  });
});

describe('Kilo Code implementer text adapter', () => {
  it('preserves text completion without inventing a structured terminal', () => {
    expect(kiloImplementerProtocolEvents('Kilo changed the files')).toEqual([
      { type: 'text', channel: 'stdout', text: 'Kilo changed the files\n' },
    ]);
  });
});

describe('Kilo Code terminal outcomes', () => {
  it('returns the exact final group after the last tool call with accumulated usage and session', () => {
    const events = [
      ...kiloPlannerProtocolEvents(
        JSON.stringify({
          type: 'text',
          sessionID: 'ses-final',
          part: { type: 'text', text: 'earlier draft' },
        }),
      ),
      ...kiloPlannerProtocolEvents(
        JSON.stringify({
          type: 'tool_result',
          sessionID: 'ses-final',
          part: { type: 'tool', id: 'tool-1', name: 'read', input: { path: 'src/a.ts' } },
        }),
      ),
      ...kiloPlannerProtocolEvents(
        JSON.stringify({
          type: 'text',
          sessionID: 'ses-final',
          part: { type: 'text', text: 'final plan' },
        }),
      ),
      ...kiloPlannerProtocolEvents(
        JSON.stringify({
          type: 'step_finish',
          sessionID: 'ses-final',
          part: { type: 'step-finish', tokens: { input: 5, output: 3, reasoning: 1 } },
        }),
      ),
    ];
    expect(
      kiloPlannerAdapter.terminal({
        outputContract: kiloPlannerAdapter.outputContract,
        events,
        stderr: '',
        exitCode: 0,
        signal: null,
      }),
    ).toEqual({
      type: 'result',
      status: 'completed',
      text: 'final plan',
      usage: { inputTokens: 5, outputTokens: 3, reasoningTokens: 1 },
      nativeSessionId: 'ses-final',
      error: null,
      partial: false,
    });
  });

  it('preserves a typed cancellation result instead of converting it to success', () => {
    const aborted = {
      type: 'result' as const,
      status: 'aborted' as const,
      text: '',
      usage: null,
      nativeSessionId: null,
      error: { code: 'user-abort', message: 'Kilo Code invocation was aborted' },
      partial: true,
    };
    expect(
      kiloPlannerAdapter.terminal({
        outputContract: kiloPlannerAdapter.outputContract,
        events: [aborted],
        stderr: '',
        exitCode: 0,
        signal: null,
      }),
    ).toEqual(aborted);
  });
});
