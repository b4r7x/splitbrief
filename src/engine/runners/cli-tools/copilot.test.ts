import { realpathSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import type { CliExecutableIdentity } from '../../../core/discovery/detection.js';
import { CLI_TOOL_CATALOG } from '../../../core/runners/cli-tool-catalog.js';
import {
  CLI_CONFORMANCE_CANDIDATES,
  copilotImplementerAdapter,
  copilotImplementerProtocolEvents,
  copilotPlannerAdapter,
  copilotPlannerProtocolEvents,
} from './copilot.js';
import { CLI_PROMPT_SENTINEL } from './candidate-contract.js';
import { invokeProcessCli } from './process-invoke.js';

const PROMPT = CLI_PROMPT_SENTINEL;
const PROJECT_DIR = process.cwd();

function plannerArgs(configuredArgs: readonly string[]) {
  return copilotPlannerAdapter.buildArgs({
    model: undefined,
    projectDir: PROJECT_DIR,
    configuredArgs,
    sessionId: null,
    effort: undefined,
  });
}

function implementerArgs() {
  return copilotImplementerAdapter.buildArgs({
    model: undefined,
    projectDir: PROJECT_DIR,
    configuredArgs: [],
  });
}

function terminalInput(
  adapter: typeof copilotPlannerAdapter,
  events: ReturnType<typeof copilotPlannerProtocolEvents>,
) {
  return adapter.terminal({
    outputContract: adapter.outputContract,
    events,
    stderr: '',
    exitCode: 0,
    signal: null,
  });
}

describe('Copilot role adapters', () => {
  it.each([
    [
      'two images',
      ['/tmp/design one.png', '/tmp/design-two.png'],
      ['--attachment', '/tmp/design one.png', '--attachment', '/tmp/design-two.png'],
    ],
    ['absent images', undefined, []],
    ['empty images', [], []],
  ] as const)('passes %s before the prompt in every role', (_label, imagePaths, imageArgs) => {
    for (const [adapter, approvalArgs] of [
      [copilotPlannerAdapter, ['--plan', '--allow-all-tools', '--no-ask-user']],
      [copilotImplementerAdapter, ['--allow-all']],
    ] as const) {
      const input = {
        model: 'gpt-5.2',
        effort: 'high',
        projectDir: PROJECT_DIR,
        configuredArgs: ['--label', 'fixture'],
        sessionId: null,
        imagePaths,
      } as const;
      const expected = [
        '--model',
        'gpt-5.2',
        '--effort',
        'high',
        ...imageArgs,
        ...approvalArgs,
        '--output-format',
        'json',
      ];
      const baseArgs = adapter.baseArgs(input);
      const invocationArgs = adapter.buildArgs(input);
      expect(baseArgs).toEqual(expected);
      expect(invocationArgs).toEqual([...expected, '--label', 'fixture']);
      expect(adapter.validateArgs({ invocationArgs, baseArgs })).toEqual({ valid: true });
    }
  });

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
      expect(candidate.rawContract.rawInvocation.filter((arg) => arg === PROMPT)).toHaveLength(0);
      expect(candidate.rawContract.promptTransport).toBe('stdin');
      expect(candidate.contractSha256).toMatch(/^[a-f0-9]{64}$/);
      expect(candidate.adapter.role).toBe(candidate.role);
      expect(candidate.adapter.descriptor).toBe(CLI_TOOL_CATALOG.copilot);
    }
    expect(CLI_CONFORMANCE_CANDIDATES[0]?.contractSha256).not.toBe(
      CLI_CONFORMANCE_CANDIDATES[1]?.contractSha256,
    );
  });

  it('keeps stdin, process-exit completion, version/auth probes, and output limits explicit', () => {
    for (const adapter of [copilotPlannerAdapter, copilotImplementerAdapter]) {
      expect(adapter.promptTransport).toEqual({ kind: 'stdin' });
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
    const args = copilotPlannerAdapter.buildArgs({
      model: 'gpt-5.2',
      projectDir: PROJECT_DIR,
      configuredArgs: ['--label', 'fixture'],
      sessionId: null,
      effort: undefined,
    });
    expect(args).toEqual([
      '--model',
      'gpt-5.2',
      '--plan',
      '--allow-all-tools',
      '--no-ask-user',
      '--output-format',
      'json',
      '--label',
      'fixture',
    ]);
    expect(
      copilotPlannerAdapter.validateArgs({ invocationArgs: args, baseArgs: args.slice(0, -2) }),
    ).toEqual({ valid: true });
  });

  it('preserves implementer --allow-all and model placement', () => {
    const args = copilotImplementerAdapter.buildArgs({
      model: 'claude-sonnet-4-6',
      projectDir: PROJECT_DIR,
      configuredArgs: ['--label', 'fixture'],
    });
    expect(args).toEqual([
      '--model',
      'claude-sonnet-4-6',
      '--allow-all',
      '--output-format',
      'json',
      '--label',
      'fixture',
    ]);
    expect(
      copilotImplementerAdapter.validateArgs({ invocationArgs: args, baseArgs: args.slice(0, -2) }),
    ).toEqual({
      valid: true,
    });
    expect(CLI_CONFORMANCE_CANDIDATES[1]?.rawContract.rawInvocation).toEqual([
      '--allow-all',
      '--output-format',
      'json',
    ]);
    expect(CLI_CONFORMANCE_CANDIDATES.map((candidate) => candidate.rawContract.asOf)).toEqual([
      '2026-09-21',
      '2026-09-21',
    ]);
  });

  it('sends the reasoning effort the seat configured, beside the model, on both roles', () => {
    const planner = copilotPlannerAdapter.buildArgs({
      model: 'gpt-5.2',
      projectDir: PROJECT_DIR,
      configuredArgs: [],
      sessionId: null,
      effort: 'high',
    });
    expect(planner).toContain('--effort');
    expect(planner[planner.indexOf('--effort') + 1]).toBe('high');

    const implementer = copilotImplementerAdapter.buildArgs({
      model: 'gpt-5.2',
      projectDir: PROJECT_DIR,
      configuredArgs: [],
      effort: 'high',
    });
    expect(implementer).toContain('--effort');
    expect(implementer[implementer.indexOf('--effort') + 1]).toBe('high');
  });

  it('sends no effort flag on either role when the seat spends none', () => {
    expect(plannerArgs([])).not.toContain('--effort');
    expect(implementerArgs()).not.toContain('--effort');
  });

  it.each([['--effort'], ['--reasoning-effort']])(
    'refuses a configured %s that would outrank the seat',
    (flag) => {
      const base = copilotPlannerAdapter.buildArgs({
        model: undefined,
        projectDir: PROJECT_DIR,
        configuredArgs: [],
        sessionId: null,
        effort: 'high',
      });

      expect(
        copilotPlannerAdapter.validateArgs({
          invocationArgs: [...base, flag, 'max'],
          baseArgs: base,
        }),
      ).toEqual({ valid: false, conflicts: [flag] });
    },
  );

  it('uses plan mode for every planner call', () => {
    const planArgs = plannerArgs([]);
    expect(planArgs).toEqual([
      '--plan',
      '--allow-all-tools',
      '--no-ask-user',
      '--output-format',
      'json',
    ]);
  });

  it('rejects reordered, protected, duplicate, embedded, and alternate prompt arguments', () => {
    const base = implementerArgs();
    expect(
      copilotImplementerAdapter.validateArgs({ invocationArgs: [PROMPT, ...base], baseArgs: base }),
    ).toEqual({
      valid: false,
      conflicts: ['argument-order', 'prompt-transport'],
    });
    expect(
      copilotImplementerAdapter.validateArgs({
        invocationArgs: [...base, '--allow-all'],
        baseArgs: base,
      }),
    ).toEqual({
      valid: false,
      conflicts: ['--allow-all'],
    });
    expect(
      copilotImplementerAdapter.validateArgs({
        invocationArgs: [...base, '--model', 'other'],
        baseArgs: base,
      }),
    ).toEqual({
      valid: false,
      conflicts: ['--model'],
    });
    expect(
      copilotImplementerAdapter.validateArgs({
        invocationArgs: [...base, '--plan'],
        baseArgs: base,
      }),
    ).toEqual({
      valid: false,
      conflicts: ['--plan'],
    });
    expect(
      copilotImplementerAdapter.validateArgs({
        invocationArgs: [...base, '--agent', 'custom'],
        baseArgs: base,
      }),
    ).toEqual({
      valid: false,
      conflicts: ['--agent'],
    });
    expect(
      copilotImplementerAdapter.validateArgs({
        invocationArgs: [...base, '--prompt', 'other'],
        baseArgs: base,
      }),
    ).toEqual({
      valid: false,
      conflicts: ['--prompt'],
    });
    expect(
      copilotImplementerAdapter.validateArgs({
        invocationArgs: [...base, '-pPROMPT'],
        baseArgs: base,
      }),
    ).toEqual({
      valid: false,
      conflicts: ['-p'],
    });
    expect(
      copilotImplementerAdapter.validateArgs({
        invocationArgs: [...base, '--yolo'],
        baseArgs: base,
      }),
    ).toEqual({
      valid: false,
      conflicts: ['--yolo'],
    });
    expect(
      copilotImplementerAdapter.validateArgs({
        invocationArgs: [...base, 'prefix-<PROMPT>'],
        baseArgs: base,
      }),
    ).toEqual({
      valid: false,
      conflicts: ['prompt-transport'],
    });
    expect(
      copilotImplementerAdapter.validateArgs({
        invocationArgs: [...base, '<OTHER>'],
        baseArgs: base,
      }),
    ).toEqual({
      valid: false,
      conflicts: ['prompt-transport'],
    });
    expect(
      copilotImplementerAdapter.validateArgs({ invocationArgs: [...base, PROMPT], baseArgs: base }),
    ).toEqual({
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
      usage: {
        inputTokens: 3,
        outputTokens: 2,
        counterCoverage: {
          input: 'reported',
          output: 'partial',
          cacheRead: 'missing',
          cacheCreate: 'missing',
          reasoning: 'missing',
        },
        providerTotals: { output: 2 },
      },
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

  it('reads implementer json like the planner (unverified live: policy-denied account)', () => {
    const events = [
      ...copilotImplementerProtocolEvents(
        JSON.stringify({ type: 'session.start', data: { sessionId: 'sess-43' } }),
      ),
      ...copilotImplementerProtocolEvents(
        JSON.stringify({
          type: 'tool.execution_start',
          data: { id: 'call-1', name: 'edit_file', input: { path: 'src/a.ts' } },
        }),
      ),
      ...copilotImplementerProtocolEvents(
        JSON.stringify({ type: 'assistant.message', data: { text: 'edited staged files' } }),
      ),
    ];
    expect(events).toEqual([
      { type: 'session', nativeSessionId: 'sess-43' },
      {
        type: 'tool-use',
        id: 'call-1',
        name: 'edit_file',
        input: { path: 'src/a.ts' },
      },
      { type: 'text', channel: 'assistant', text: 'edited staged files' },
    ]);
    expect(copilotImplementerProtocolEvents('edited staged files')).toEqual([
      expect.objectContaining({ type: 'warning', code: 'malformed_copilot' }),
    ]);
    expect(copilotImplementerAdapter.outputContract).toEqual({
      kind: 'text-exit',
      successfulExitCodes: [0],
    });
    const terminal = copilotImplementerAdapter.terminal({
      outputContract: copilotImplementerAdapter.outputContract,
      events,
      stderr: '',
      exitCode: 0,
      signal: null,
    });
    expect(terminal).toMatchObject({
      type: 'result',
      status: 'completed',
      usage: null,
      nativeSessionId: 'sess-43',
      error: null,
      partial: false,
    });
  });

  const TOOL_RECORDS = [
    {
      type: 'tool.execution_start',
      data: { id: 'call-1', name: 'edit_file', input: { path: 'src/a.ts' } },
    },
    { type: 'tool.call', data: { id: 'call-2', name: 'read_file', input: { path: 'src/b.ts' } } },
    { type: 'tool.use', data: { id: 'call-3', tool: 'bash', args: { command: 'ls' } } },
  ];

  function executableIdentity(candidate: string): CliExecutableIdentity {
    const path = realpathSync(candidate);
    const info = statSync(path);
    return {
      path,
      fingerprint: { dev: info.dev, ino: info.ino, size: info.size, mtimeMs: info.mtimeMs },
    };
  }

  it('records each copilot tool event as a finished tool use', () => {
    expect(
      TOOL_RECORDS.flatMap((record) => copilotImplementerProtocolEvents(JSON.stringify(record))),
    ).toEqual([
      { type: 'tool-use', id: 'call-1', name: 'edit_file', input: { path: 'src/a.ts' } },
      { type: 'tool-use', id: 'call-2', name: 'read_file', input: { path: 'src/b.ts' } },
      { type: 'tool-use', id: 'call-3', name: 'bash', input: { command: 'ls' } },
    ]);
  });

  it('lands every tool a copilot implementer ran in the call result', async () => {
    const lines = [
      { type: 'session.start', data: { sessionId: 'sess-44' } },
      ...TOOL_RECORDS,
      { type: 'assistant.message', data: { text: 'edited staged files' } },
    ].map((record) => JSON.stringify(record));
    const result = await invokeProcessCli(copilotImplementerAdapter, {
      invocation: {
        executable: executableIdentity(process.execPath),
        args: ['-e', `process.stdout.write(${JSON.stringify(`${lines.join('\n')}\n`)})`],
        promptTransport: copilotImplementerAdapter.promptTransport,
        environment: {},
        cwd: tmpdir(),
        timeoutMs: 5_000,
        signal: undefined,
      },
      prompt: 'fixture prompt',
      callContext: {
        callId: 'copilot-tools',
        role: 'implementer',
        backendKind: 'cli',
        runnerName: 'copilot',
      },
    });

    expect(result.status).toBe('completed');
    expect(result.toolUses.map((toolUse) => toolUse.name)).toEqual([
      'edit_file',
      'read_file',
      'bash',
    ]);
  });
});
