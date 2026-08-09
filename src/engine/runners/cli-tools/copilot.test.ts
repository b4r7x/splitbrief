import { describe, expect, it } from 'vitest';
import { CLI_TOOL_CATALOG } from '../../../core/runners/cli-tool-catalog.js';
import {
  CLI_CONFORMANCE_CANDIDATES,
  copilotImplementerAdapter,
  copilotImplementerProtocolEvents,
  copilotPlannerAdapter,
  copilotPlannerProtocolEvents,
  copilotPromptArgs,
} from './copilot.js';

const PROMPT = '<PROMPT>';

function terminalInput(
  adapter: typeof copilotPlannerAdapter,
  events: ReturnType<typeof copilotPlannerProtocolEvents>,
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

describe('Copilot role adapters', () => {
  it('exports planner then implementer candidates with matching canonical hashes', () => {
    expect(CLI_CONFORMANCE_CANDIDATES).toHaveLength(2);
    expect(CLI_CONFORMANCE_CANDIDATES.map((candidate) => candidate.role)).toEqual([
      'planner',
      'implementer',
    ]);
    for (const candidate of CLI_CONFORMANCE_CANDIDATES) {
      expect(candidate.id).toBe('copilot');
      expect(candidate.rawContract.id).toBe(candidate.id);
      expect(candidate.rawContract.role).toBe(candidate.role);
      expect(candidate.rawContract.rawInvocation.filter((arg) => arg === PROMPT)).toHaveLength(1);
      expect(candidate.contractSha256).toMatch(/^[a-f0-9]{64}$/);
      expect(candidate.adapter.role).toBe(candidate.role);
      expect(candidate.adapter.descriptor).toBe(CLI_TOOL_CATALOG.copilot);
    }
    expect(CLI_CONFORMANCE_CANDIDATES[0]?.contractSha256).not.toBe(
      CLI_CONFORMANCE_CANDIDATES[1]?.contractSha256,
    );
  });

  it('keeps argv, process-exit completion, version/auth probes, and output limits explicit', () => {
    for (const adapter of [copilotPlannerAdapter, copilotImplementerAdapter]) {
      expect(adapter.promptTransport).toEqual({
        kind: 'argv',
        maxBytes: 120_000,
        placement: 'flag-value',
      });
      expect(adapter.outputContract).toEqual({ kind: 'text-exit', successfulExitCodes: [0] });
      expect(adapter.probe.version).toEqual({
        command: ['copilot', '--version'],
        cwd: 'neutral',
        timeoutMs: 5_000,
        maxOutputBytes: 4_096,
      });
      expect(adapter.probe.auth).toEqual({
        command: ['copilot', 'auth', 'status'],
        cwd: 'neutral',
        timeoutMs: 5_000,
        maxOutputBytes: 4_096,
      });
    }
  });

  it('keeps Copilot implementer direct-write posture visible to the shared proof boundary', () => {
    expect(copilotImplementerAdapter.descriptor.directWrite.implementer).toBe(true);
    expect(copilotImplementerAdapter.descriptor.roles).toContain('implementer');
  });

  it('preserves planner JSON, model placement, and configured argument order', () => {
    const args = copilotPromptArgs({
      role: 'planner',
      model: 'gpt-5.2',
      configuredArgs: ['--label', 'fixture'],
    });
    expect(args).toEqual([
      '--model',
      'gpt-5.2',
      '-p',
      PROMPT,
      '--plan',
      '--allow-all-tools',
      '--no-ask-user',
      '--output-format',
      'json',
      '--label',
      'fixture',
    ]);
    expect(copilotPlannerAdapter.validateArgs(args, args.slice(0, -2))).toEqual({ valid: true });
  });

  it('preserves implementer --allow-all and model placement', () => {
    const args = copilotPromptArgs({
      role: 'implementer',
      model: 'claude-sonnet-4-6',
      configuredArgs: ['--label', 'fixture'],
    });
    expect(args).toEqual([
      '--model',
      'claude-sonnet-4-6',
      '-p',
      PROMPT,
      '--allow-all',
      '--label',
      'fixture',
    ]);
    expect(copilotImplementerAdapter.validateArgs(args, args.slice(0, -2))).toEqual({
      valid: true,
    });
    expect(args).toContain('--allow-all');
  });

  it('uses plan mode for read-only calls and direct-write approval for full escalation', () => {
    const planArgs = copilotPromptArgs({ role: 'planner' });
    expect(planArgs).toEqual([
      '-p',
      PROMPT,
      '--plan',
      '--allow-all-tools',
      '--no-ask-user',
      '--output-format',
      'json',
    ]);
    expect(planArgs).not.toContain('--allow-all');

    const escalationArgs = copilotPromptArgs({ role: 'planner', mode: 'escalate' });
    expect(escalationArgs).toEqual([
      '-p',
      PROMPT,
      '--allow-all',
      '--no-ask-user',
      '--output-format',
      'json',
    ]);
    expect(escalationArgs).not.toContain('--plan');
    expect(
      copilotPlannerAdapter.validateArgs(
        copilotPromptArgs({
          role: 'planner',
          mode: 'escalate',
          configuredArgs: ['--plan'],
        }),
        escalationArgs,
      ),
    ).toEqual({ valid: false, conflicts: ['--plan'] });
  });

  it('rejects reordered, protected, duplicate, embedded, and alternate prompt arguments', () => {
    const base = copilotPromptArgs({ role: 'implementer' });
    expect(copilotImplementerAdapter.validateArgs([PROMPT, ...base], base)).toEqual({
      valid: false,
      conflicts: ['argument-order', 'prompt-transport'],
    });
    expect(copilotImplementerAdapter.validateArgs([...base, '--allow-all'], base)).toEqual({
      valid: false,
      conflicts: ['--allow-all'],
    });
    expect(copilotImplementerAdapter.validateArgs([...base, '--model', 'other'], base)).toEqual({
      valid: false,
      conflicts: ['--model'],
    });
    expect(copilotImplementerAdapter.validateArgs([...base, '--plan'], base)).toEqual({
      valid: false,
      conflicts: ['--plan'],
    });
    expect(copilotImplementerAdapter.validateArgs([...base, '--agent', 'custom'], base)).toEqual({
      valid: false,
      conflicts: ['--agent'],
    });
    expect(copilotImplementerAdapter.validateArgs([...base, '--prompt', 'other'], base)).toEqual({
      valid: false,
      conflicts: ['--prompt'],
    });
    expect(copilotImplementerAdapter.validateArgs([...base, '-pPROMPT'], base)).toEqual({
      valid: false,
      conflicts: ['-p'],
    });
    expect(copilotImplementerAdapter.validateArgs([...base, '--yolo'], base)).toEqual({
      valid: false,
      conflicts: ['--yolo'],
    });
    expect(copilotImplementerAdapter.validateArgs([...base, 'prefix-<PROMPT>'], base)).toEqual({
      valid: false,
      conflicts: ['prompt-transport'],
    });
    expect(copilotImplementerAdapter.validateArgs([...base, '<OTHER>'], base)).toEqual({
      valid: false,
      conflicts: ['prompt-transport'],
    });
    expect(copilotImplementerAdapter.validateArgs([...base, PROMPT], base)).toEqual({
      valid: false,
      conflicts: ['prompt-transport'],
    });
  });
});

describe('Copilot JSON and text protocol adapters', () => {
  it('projects planner session, assistant text, usage, and tools', () => {
    const events = [
      ...copilotPlannerProtocolEvents(
        JSON.stringify({ type: 'session.start', data: { sessionId: 'sess-42' } }),
      ),
      ...copilotPlannerProtocolEvents(
        JSON.stringify({
          type: 'assistant.message',
          data: { text: 'compiled brief', usage: { input_tokens: 3, output_tokens: 2 } },
        }),
      ),
      ...copilotPlannerProtocolEvents(
        JSON.stringify({
          type: 'tool.execution_start',
          data: { name: 'read_file', input: { path: 'src/a.ts' } },
        }),
      ),
    ];
    expect(events).toContainEqual({ type: 'session', nativeSessionId: 'sess-42' });
    expect(events).toContainEqual({ type: 'text', channel: 'assistant', text: 'compiled brief' });
    expect(events).toContainEqual({
      type: 'usage',
      usage: { inputTokens: 3, outputTokens: 2 },
      semantics: 'delta',
    });
    expect(events).toContainEqual({
      type: 'tool-use',
      id: null,
      name: 'read_file',
      input: { path: 'src/a.ts' },
    });
    expect(terminalInput(copilotPlannerAdapter, events)).toMatchObject({
      type: 'result',
      status: 'completed',
      nativeSessionId: 'sess-42',
      usage: { inputTokens: 3, outputTokens: 2 },
      error: null,
      partial: false,
    });
  });

  it('keeps unknown and malformed planner records as bounded warnings', () => {
    expect(
      copilotPlannerProtocolEvents(JSON.stringify({ type: 'future.event', data: {} })),
    ).toEqual([expect.objectContaining({ type: 'warning', code: 'unknown_copilot_record' })]);
    expect(copilotPlannerProtocolEvents('{not-json')).toEqual([
      expect.objectContaining({ type: 'warning', code: 'malformed_copilot' }),
    ]);
  });

  it('uses bounded text completion for implementer output without inventing a terminal event', () => {
    expect(copilotImplementerProtocolEvents('edited staged files')).toEqual([
      { type: 'text', channel: 'stdout', text: 'edited staged files\n' },
    ]);
    expect(copilotImplementerAdapter.outputContract).toEqual({
      kind: 'text-exit',
      successfulExitCodes: [0],
    });
    const terminal = copilotImplementerAdapter.terminal({
      outputContract: copilotImplementerAdapter.outputContract,
      events: copilotImplementerProtocolEvents('edited staged files'),
      stdout: 'edited staged files\n',
      stderr: '',
      exitCode: 0,
      signal: null,
    });
    expect(terminal).toMatchObject({
      type: 'result',
      status: 'completed',
      usage: null,
      nativeSessionId: null,
      error: null,
      partial: false,
    });
  });
});
