import { describe, expect, it } from 'vitest';
import { CLI_TOOL_CATALOG } from '../../../core/runners/cli-tool-catalog.js';
import {
  CLI_CONFORMANCE_CANDIDATES,
  kiloImplementerAdapter,
  kiloImplementerProtocolEvents,
  kiloPlannerAdapter,
  kiloPlannerProtocolEvents,
  kiloPromptArgs,
} from './kilo-code.js';

const PROMPT = '<PROMPT>';

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
    expect(CLI_CONFORMANCE_CANDIDATES[0]?.contractSha256).not.toBe(
      CLI_CONFORMANCE_CANDIDATES[1]?.contractSha256,
    );
  });

  it('keeps argv transport, process-exit completion, and five-second probes explicit', () => {
    for (const adapter of [kiloPlannerAdapter, kiloImplementerAdapter]) {
      expect(adapter.promptTransport).toEqual({ kind: 'argv', maxBytes: 120_000 });
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

  it('preserves planner architect JSON flags, implementer auto mode, model placement, and order', () => {
    expect(
      kiloPromptArgs({ role: 'planner', model: undefined, configuredArgs: ['--verbose'] }),
    ).toEqual(['run', '--format', 'json', '--agent', 'architect', PROMPT, '--verbose']);
    expect(
      kiloPromptArgs({ role: 'planner', model: 'claude-sonnet-4-6', configuredArgs: [] }),
    ).toEqual([
      'run',
      '--model',
      'claude-sonnet-4-6',
      '--format',
      'json',
      '--agent',
      'architect',
      PROMPT,
    ]);
    expect(
      kiloPromptArgs({
        role: 'implementer',
        model: 'qwen2.5-coder:7b',
        configuredArgs: ['--verbose'],
      }),
    ).toEqual(['run', '--model', 'qwen2.5-coder:7b', '--auto', PROMPT, '--verbose']);
    expect(kiloPlannerAdapter.validateArgs(kiloPromptArgs({ role: 'planner' }))).toEqual({
      valid: true,
    });
    expect(kiloImplementerAdapter.validateArgs(kiloPromptArgs({ role: 'implementer' }))).toEqual({
      valid: true,
    });
  });

  it('rejects protected flags, reordered args, and alternate prompt placeholders', () => {
    const args = kiloPromptArgs({ role: 'implementer' });
    expect(kiloImplementerAdapter.validateArgs([PROMPT, ...args])).toEqual({
      valid: false,
      conflicts: ['argument-order', 'prompt-transport'],
    });
    expect(kiloImplementerAdapter.validateArgs([...args, '--auto'])).toEqual({
      valid: false,
      conflicts: ['--auto'],
    });
    expect(kiloImplementerAdapter.validateArgs([...args, 'prefix-<PROMPT>'])).toEqual({
      valid: false,
      conflicts: ['prompt-transport'],
    });
    expect(kiloImplementerAdapter.validateArgs([...args, '<OTHER>'])).toEqual({
      valid: false,
      conflicts: ['prompt-transport'],
    });
    expect(kiloImplementerAdapter.validateArgs([...args, PROMPT])).toEqual({
      valid: false,
      conflicts: ['prompt-transport'],
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
  it('accumulates planner usage and session identity on process completion', () => {
    const events = [
      ...kiloPlannerProtocolEvents(
        JSON.stringify({
          type: 'text',
          sessionID: 'ses-final',
          part: { type: 'text', text: 'done' },
        }),
      ),
      ...kiloPlannerProtocolEvents(
        JSON.stringify({
          type: 'step_finish',
          sessionID: 'ses-final',
          part: { type: 'step-finish', tokens: { input: 2, output: 1 } },
        }),
      ),
    ];
    expect(
      kiloPlannerAdapter.terminal({
        outputContract: kiloPlannerAdapter.outputContract,
        events,
        stdout: '',
        stderr: '',
        exitCode: 0,
        signal: null,
      }),
    ).toEqual({
      type: 'result',
      status: 'completed',
      text: '',
      usage: { inputTokens: 2, outputTokens: 1 },
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
        stdout: '',
        stderr: '',
        exitCode: 0,
        signal: null,
      }),
    ).toEqual(aborted);
  });
});
