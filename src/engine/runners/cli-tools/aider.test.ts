import { describe, expect, it } from 'vitest';
import { CLI_TOOL_CATALOG } from '../../../core/runners/cli-tool-catalog.js';
import {
  CLI_CONFORMANCE_CANDIDATES,
  aiderImplementerAdapter,
  aiderPlannerAdapter,
  aiderPromptArgs,
  aiderProtocolEvents,
} from './aider.js';

const PROMPT = '<PROMPT>';

describe('Aider role adapters', () => {
  it('exports planner then implementer candidates with matching canonical hashes', () => {
    expect(CLI_CONFORMANCE_CANDIDATES).toHaveLength(2);
    expect(CLI_CONFORMANCE_CANDIDATES.map((candidate) => candidate.role)).toEqual([
      'planner',
      'implementer',
    ]);
    for (const candidate of CLI_CONFORMANCE_CANDIDATES) {
      expect(candidate.id).toBe('aider');
      expect(candidate.rawContract.id).toBe(candidate.id);
      expect(candidate.rawContract.role).toBe(candidate.role);
      expect(candidate.rawContract.rawInvocation.filter((arg) => arg === PROMPT)).toHaveLength(1);
      expect(candidate.contractSha256).toMatch(/^[a-f0-9]{64}$/);
      expect(candidate.adapter.role).toBe(candidate.role);
      expect(candidate.adapter.descriptor).toBe(CLI_TOOL_CATALOG.aider);
    }
    expect(CLI_CONFORMANCE_CANDIDATES[0]?.contractSha256).not.toBe(
      CLI_CONFORMANCE_CANDIDATES[1]?.contractSha256,
    );
  });

  it('keeps argv transport, text completion, and bounded probes explicit', () => {
    for (const adapter of [aiderPlannerAdapter, aiderImplementerAdapter]) {
      expect(adapter.promptTransport).toEqual({
        kind: 'argv',
        maxBytes: 120_000,
        placement: 'flag-value',
      });
      expect(adapter.outputContract).toEqual({ kind: 'text-exit', successfulExitCodes: [0] });
      expect(adapter.probe.version).toEqual({
        command: ['aider', '--version'],
        cwd: 'neutral',
        timeoutMs: 5_000,
        maxOutputBytes: 4_096,
      });
      expect(adapter.probe.auth).toEqual({
        command: ['aider', 'auth'],
        cwd: 'neutral',
        timeoutMs: 5_000,
        maxOutputBytes: 4_096,
      });
    }
  });

  it('preserves planner ask flags, model placement, and optional source read', () => {
    const args = aiderPromptArgs({
      role: 'planner',
      model: 'claude-sonnet-4-6',
      projectDir: '',
      mode: 'plan',
      configuredArgs: ['--verbose'],
    });
    expect(args).toEqual([
      '--model',
      'claude-sonnet-4-6',
      '--chat-mode',
      'ask',
      '--yes-always',
      '--no-stream',
      '--no-pretty',
      '--message',
      PROMPT,
      '--verbose',
    ]);
    expect(aiderPlannerAdapter.validateArgs(args, args.slice(0, -1))).toEqual({ valid: true });
  });

  it('preserves implementer no-commit flags and appends an explicit model', () => {
    const args = aiderPromptArgs({
      role: 'implementer',
      model: 'openai/gpt-5',
      configuredArgs: ['--verbose'],
    });
    expect(args).toEqual([
      '--message',
      PROMPT,
      '--yes-always',
      '--no-auto-commits',
      '--no-dirty-commits',
      '--model',
      'openai/gpt-5',
      '--verbose',
    ]);
    expect(args).not.toContain('--commit');
    expect(aiderImplementerAdapter.validateArgs(args, args.slice(0, -1))).toEqual({ valid: true });
  });

  it('overrides read-only and dry-run config defaults for full escalation', () => {
    const args = aiderPromptArgs({
      role: 'planner',
      model: 'claude-sonnet-4-6',
      projectDir: '',
      mode: 'escalate',
    });

    expect(args).toEqual([
      '--model',
      'claude-sonnet-4-6',
      '--edit-format',
      'whole',
      '--yes-always',
      '--no-auto-commits',
      '--no-dirty-commits',
      '--no-dry-run',
      '--no-stream',
      '--no-pretty',
      '--message',
      PROMPT,
    ]);
    expect(args).not.toContain('--chat-mode');
    expect(args).not.toContain('ask');
    expect(
      aiderPlannerAdapter.validateArgs(
        aiderPromptArgs({
          role: 'planner',
          model: 'claude-sonnet-4-6',
          projectDir: '',
          mode: 'escalate',
          configuredArgs: ['--architect', '--dry-run'],
        }),
        args,
      ),
    ).toEqual({ valid: false, conflicts: ['--architect', '--dry-run'] });
  });

  it.each([
    { tail: ['--msg', 'other'], conflict: '--msg' },
    { tail: ['-m', 'other'], conflict: '-m' },
    { tail: ['-mPROMPT'], conflict: '-m' },
    { tail: ['--architect'], conflict: '--architect' },
    { tail: ['--auto-commits'], conflict: '--auto-commits' },
    { tail: ['--dirty-commits'], conflict: '--dirty-commits' },
    { tail: ['--commit'], conflict: '--commit' },
  ])('rejects the protected configured-tail bypass $conflict', ({ tail, conflict }) => {
    const base = aiderPromptArgs({ role: 'implementer' });

    expect(aiderImplementerAdapter.validateArgs([...base, ...tail], base)).toEqual({
      valid: false,
      conflicts: [conflict],
    });
  });

  it('rejects reordered, protected, and alternate prompt arguments', () => {
    const base = aiderPromptArgs({ role: 'implementer' });
    expect(aiderImplementerAdapter.validateArgs([PROMPT, ...base], base)).toEqual({
      valid: false,
      conflicts: ['argument-order', 'prompt-transport'],
    });
    expect(aiderImplementerAdapter.validateArgs([...base, '--message', 'other'], base)).toEqual({
      valid: false,
      conflicts: ['--message'],
    });
    expect(aiderImplementerAdapter.validateArgs([...base, '--edit-format', 'diff'], base)).toEqual({
      valid: false,
      conflicts: ['--edit-format'],
    });
    expect(aiderImplementerAdapter.validateArgs([...base, '--dry-run'], base)).toEqual({
      valid: false,
      conflicts: ['--dry-run'],
    });
    expect(aiderImplementerAdapter.validateArgs([...base, 'prefix-<PROMPT>'], base)).toEqual({
      valid: false,
      conflicts: ['prompt-transport'],
    });
    expect(aiderImplementerAdapter.validateArgs([...base, '<OTHER>'], base)).toEqual({
      valid: false,
      conflicts: ['prompt-transport'],
    });
    expect(aiderImplementerAdapter.validateArgs([...base, PROMPT], base)).toEqual({
      valid: false,
      conflicts: ['prompt-transport'],
    });
  });
});

describe('Aider text adapter', () => {
  it('projects text lines and final usage without inventing a structured terminal', () => {
    expect(aiderProtocolEvents('Aider response')).toEqual([
      { type: 'text', channel: 'stdout', text: 'Aider response\n' },
    ]);
    expect(aiderProtocolEvents('Tokens: 100 sent, 50 received.')).toEqual([
      {
        type: 'usage',
        usage: { inputTokens: 100, outputTokens: 50 },
        semantics: 'final',
      },
    ]);
    expect(
      aiderPlannerAdapter.terminal({
        outputContract: aiderPlannerAdapter.outputContract,
        events: [
          {
            type: 'usage',
            usage: { inputTokens: 2, outputTokens: 1 },
            semantics: 'final',
          },
        ],
        stdout: 'Aider response\n',
        stderr: 'Tokens: 100 sent, 50 received.\n',
        exitCode: 0,
        signal: null,
      }),
    ).toEqual({
      type: 'result',
      status: 'completed',
      text: '',
      usage: { inputTokens: 100, outputTokens: 50 },
      nativeSessionId: null,
      error: null,
      partial: false,
    });
  });
});
