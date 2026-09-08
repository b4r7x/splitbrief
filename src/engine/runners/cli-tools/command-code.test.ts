import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { toTokenDelta } from '../../calls/usage.js';
import type { EffortLevel } from '../../../core/schemas/enums.js';
import {
  CLI_TOOL_CATALOG,
  COMMAND_CODE_CLI_ADMISSION_VERDICT,
} from '../../../core/runners/cli-tool-catalog.js';
import { CLI_PROMPT_SENTINEL, UnregisteredCliCandidate } from './candidate-contract.js';
import { validateCliArgs } from './validate-args.js';
import {
  CLI_CONFORMANCE_CANDIDATES,
  COMMAND_CODE_PROTECTED_FLAGS,
  commandCodeImplementerAdapter,
  commandCodePlannerAdapter,
  commandCodeProtocolEvents,
} from './command-code.js';

const PROMPT = CLI_PROMPT_SENTINEL;
const NDJSON_FIXTURE = join(
  import.meta.dirname,
  '../../../../testing/fixtures/command-code/json-result.txt',
);

function plannerArgs(
  mode: 'plan' | 'escalate',
  options: {
    model?: string | undefined;
    configuredArgs?: readonly string[];
    effort?: EffortLevel | undefined;
  } = {},
) {
  return commandCodePlannerAdapter.buildArgs({
    prompt: PROMPT,
    model: options.model,
    projectDir: '/project',
    configuredArgs: options.configuredArgs ?? [],
    mode,
    sessionId: null,
    effort: options.effort,
  });
}

function implementerArgs(
  options: {
    model?: string | undefined;
    configuredArgs?: readonly string[];
    effort?: EffortLevel | undefined;
  } = {},
) {
  return commandCodeImplementerAdapter.buildArgs({
    prompt: PROMPT,
    model: options.model,
    projectDir: '/staged',
    configuredArgs: options.configuredArgs ?? [],
    effort: options.effort,
  });
}

function fixtureNdjsonLines(): readonly string[] {
  return readFileSync(NDJSON_FIXTURE, 'utf8')
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line.startsWith('{'));
}

function fixtureEvents() {
  return fixtureNdjsonLines().flatMap((line) => [...commandCodeProtocolEvents(line)]);
}

function terminalOf(events: ReturnType<typeof commandCodeProtocolEvents>) {
  return commandCodePlannerAdapter.terminal({
    outputContract: commandCodePlannerAdapter.outputContract,
    events,
    stderr: '',
    exitCode: 0,
    signal: null,
  });
}

describe('Command Code CLI', () => {
  it('is admitted as an active CLI tool', () => {
    expect(COMMAND_CODE_CLI_ADMISSION_VERDICT).toBe('PASS');
    expect(CLI_TOOL_CATALOG['command-code'].admission.state).toBe('active');
    expect(CLI_TOOL_CATALOG['command-code']).toMatchObject({
      id: 'command-code',
      command: 'cmd',
      category: 'cli',
      supportsEffort: true,
      effortChannel: 'effort-flag',
    });
  });
});

describe('Command Code role adapters', () => {
  it('assembles planner plan-mode args without any write-enabling permission flag', () => {
    const args = plannerArgs('plan');
    expect(args).toEqual([
      '-p',
      '--output-format',
      'json',
      '--trust',
      '--skip-onboarding',
      '--no-auto-update',
      '--permission-mode',
      'plan',
      PROMPT,
    ]);
  });

  it('write-enables only the implementer seat with --yolo', () => {
    const args = implementerArgs();
    expect(args).toEqual([
      '-p',
      '--output-format',
      'json',
      '--trust',
      '--skip-onboarding',
      '--no-auto-update',
      '--yolo',
      PROMPT,
    ]);
  });

  it('escalates a planner call to --yolo only in escalate mode', () => {
    expect(plannerArgs('escalate')).toEqual([
      '-p',
      '--output-format',
      'json',
      '--trust',
      '--skip-onboarding',
      '--no-auto-update',
      '--yolo',
      PROMPT,
    ]);
  });

  it('appends -m only when a model is configured', () => {
    const withModel = plannerArgs('plan', { model: 'deepseek/deepseek-v4-flash' });
    expect(withModel.slice(-3)).toEqual(['-m', 'deepseek/deepseek-v4-flash', PROMPT]);
    expect(implementerArgs({ model: 'deepseek/deepseek-v4-flash' }).slice(-3)).toEqual([
      '-m',
      'deepseek/deepseek-v4-flash',
      PROMPT,
    ]);
    expect(plannerArgs('plan', { model: undefined })).not.toContain('-m');
    expect(implementerArgs({ model: undefined })).not.toContain('-m');
  });

  it('appends --effort only when an effort level is configured', () => {
    expect(plannerArgs('plan', { effort: 'high' }).slice(-3)).toEqual(['--effort', 'high', PROMPT]);
    expect(implementerArgs({ effort: 'low' }).slice(-3)).toEqual(['--effort', 'low', PROMPT]);
    expect(plannerArgs('plan')).not.toContain('--effort');
    expect(implementerArgs()).not.toContain('--effort');
  });

  it('appends configured args after the adapter-owned base args', () => {
    const base = plannerArgs('plan');
    expect(plannerArgs('plan', { configuredArgs: ['--verbose', '--max-turns', '5'] })).toEqual([
      ...base,
      '--verbose',
      '--max-turns',
      '5',
    ]);
    const implementerBase = implementerArgs();
    expect(implementerArgs({ configuredArgs: ['--verbose'] })).toEqual([
      ...implementerBase,
      '--verbose',
    ]);
  });

  it('rejects configured args that collide with a protected flag', () => {
    const base = plannerArgs('plan');
    const implementerBase = implementerArgs();
    expect(
      commandCodePlannerAdapter.validateArgs({
        invocationArgs: [...base, '--output-format', 'text'],
        baseArgs: base,
      }),
    ).toEqual({ valid: false, conflicts: ['--output-format'] });
    expect(
      commandCodePlannerAdapter.validateArgs({
        invocationArgs: [...base, '--permission-mode', 'dont-ask'],
        baseArgs: base,
      }),
    ).toEqual({ valid: false, conflicts: ['--permission-mode'] });
    expect(
      commandCodePlannerAdapter.validateArgs({
        invocationArgs: [...base, '--yolo'],
        baseArgs: base,
      }),
    ).toEqual({ valid: false, conflicts: ['--yolo'] });
    expect(
      commandCodeImplementerAdapter.validateArgs({
        invocationArgs: [...implementerBase, '-m', 'other'],
        baseArgs: implementerBase,
      }),
    ).toEqual({ valid: false, conflicts: ['-m'] });
    expect(
      commandCodeImplementerAdapter.validateArgs({
        invocationArgs: [...implementerBase, '-mother'],
        baseArgs: implementerBase,
      }),
    ).toEqual({ valid: false, conflicts: ['-m'] });
    expect(
      commandCodeImplementerAdapter.validateArgs({
        invocationArgs: [...implementerBase, '--verbose'],
        baseArgs: implementerBase,
      }),
    ).toEqual({ valid: true });
  });

  it('protects only the flags the adapter itself emits', () => {
    for (const flag of [
      '-p',
      '--output-format',
      '--trust',
      '--skip-onboarding',
      '--no-auto-update',
      '--permission-mode',
      '-m',
    ]) {
      expect(COMMAND_CODE_PROTECTED_FLAGS.has(flag)).toBe(true);
    }
    expect(COMMAND_CODE_PROTECTED_FLAGS.has('--add-dir')).toBe(false);
    expect(COMMAND_CODE_PROTECTED_FLAGS.has('--cwd')).toBe(false);
  });

  it('leaves a working-directory flag to the shared authority scan, not its own flag list', () => {
    const base = plannerArgs('plan');
    const args = plannerArgs('plan', { configuredArgs: ['--add-dir', '/tmp/x'] });
    expect(args.slice(base.length)).toEqual(['--add-dir', '/tmp/x']);

    const refusal = commandCodePlannerAdapter.validateArgs({
      invocationArgs: args,
      baseArgs: base,
    });
    expect(refusal).toEqual({ valid: false, conflicts: ['--add-dir'] });
    expect(
      validateCliArgs({
        invocationArgs: args,
        baseArgs: base,
        protectedFlags: new Set(),
        promptTransport: 'argv',
      }),
    ).toEqual(refusal);
  });

  it('maps the recorded NDJSON fixture to session, usage, and one terminal result', () => {
    const events = fixtureEvents();
    const results = events.filter((event) => event.type === 'result');
    expect(results).toHaveLength(1);
    expect(terminalOf(events)).toMatchObject({
      type: 'result',
      status: 'completed',
      text: 'ok',
      nativeSessionId: 'cbb9c239-83c1-4e53-aa48-b0efeb5589d1',
      error: null,
      partial: false,
    });
    expect(events.filter((event) => event.type === 'session')).toEqual([
      { type: 'session', nativeSessionId: 'cbb9c239-83c1-4e53-aa48-b0efeb5589d1' },
    ]);
    const expectedUsage = toTokenDelta({
      inputTokens: 20154,
      outputTokens: 2,
      cacheReadTokens: 5888,
      cacheWriteTokens: 0,
    });
    expect(expectedUsage).not.toBeNull();
    expect(events.filter((event) => event.type === 'usage')).toEqual([
      { type: 'usage', usage: expectedUsage, semantics: 'final' },
    ]);
    expect(terminalOf(events).usage).toEqual(expectedUsage);
  });

  // The recorded run needed no tools, so the tool-use mapping is pinned to the
  // `tool_running` payload the shipped CLI emits (`toolCallId`, `toolName`)
  // rather than to a fixture line.
  it('maps a tool_running event to a tool-use event', () => {
    expect(
      commandCodeProtocolEvents(
        JSON.stringify({
          type: 'event',
          event: {
            type: 'tool_running',
            toolCallId: 'call_1',
            toolName: 'read_file',
            description: 'Read src/example.ts',
          },
        }),
      ),
    ).toEqual([{ type: 'tool-use', id: 'call_1', name: 'read_file', input: {} }]);
  });

  it('fails the protocol on malformed JSON and on a non-record line', () => {
    expect(commandCodeProtocolEvents('{not-json')).toEqual([
      {
        type: 'result',
        status: 'failed',
        text: '',
        usage: null,
        nativeSessionId: null,
        error: {
          code: 'malformed-command-code-json',
          message: 'Command Code emitted malformed JSON',
        },
        partial: false,
      },
    ]);
    expect(commandCodeProtocolEvents('[1,2]')).toMatchObject([
      {
        type: 'result',
        status: 'failed',
        error: {
          code: 'malformed-command-code-record',
          message: 'Command Code record is malformed',
        },
      },
    ]);
    expect(commandCodeProtocolEvents('   ')).toEqual([]);
  });

  it('ignores an event frame whose tool name is unreadable', () => {
    expect(
      commandCodeProtocolEvents(
        JSON.stringify({ type: 'event', event: { type: 'tool_running', toolCallId: 'call_1' } }),
      ),
    ).toEqual([]);
  });

  it('fails the protocol when a result carries usage it cannot normalize', () => {
    expect(
      commandCodeProtocolEvents(
        JSON.stringify({
          type: 'result',
          subtype: 'success',
          sessionId: 's1',
          finalText: 'done',
          usage: { tokens_in: 100, tokens_out: 20 },
        }),
      ),
    ).toMatchObject([
      {
        type: 'result',
        status: 'failed',
        error: { code: 'malformed-command-code-record' },
      },
    ]);
    expect(
      commandCodeProtocolEvents(
        JSON.stringify({ type: 'result', subtype: 'success', finalText: 'done', usage: {} }),
      ),
    ).toMatchObject([{ type: 'result', status: 'completed', usage: null }]);
  });

  it('reports a non-success subtype as a failed terminal result', () => {
    const events = commandCodeProtocolEvents(
      JSON.stringify({ type: 'result', subtype: 'max_turns', stopReason: 'max_turns' }),
    );
    expect(events.at(-1)).toMatchObject({
      type: 'result',
      status: 'failed',
      error: { code: 'command-code-result-failed', message: 'max_turns' },
    });
  });

  it('warns on an unknown top-level record type', () => {
    expect(commandCodeProtocolEvents(JSON.stringify({ type: 'telemetry' }))).toEqual([
      {
        type: 'warning',
        code: 'unknown-command-code-record',
        message: 'Unknown Command Code record',
      },
    ]);
  });

  it('throws when output ends without a terminal result', () => {
    expect(() =>
      commandCodePlannerAdapter.terminal({
        outputContract: commandCodePlannerAdapter.outputContract,
        events: [],
        stderr: '',
        exitCode: 0,
        signal: null,
      }),
    ).toThrow(/without a terminal result/u);
  });

  it('publishes one conformance candidate per role with a matching contract hash', () => {
    expect(CLI_CONFORMANCE_CANDIDATES).toHaveLength(2);
    expect(CLI_CONFORMANCE_CANDIDATES.map((candidate) => candidate.role)).toEqual([
      'planner',
      'implementer',
    ]);
    for (const candidate of CLI_CONFORMANCE_CANDIDATES) {
      expect(() => UnregisteredCliCandidate.parse(candidate)).not.toThrow();
      expect(candidate.id).toBe('command-code');
      expect(candidate.adapter.descriptor.id).toBe('command-code');
      expect(candidate.adapter.role).toBe(candidate.role);
      expect(candidate.contractSha256).toMatch(/^[a-f0-9]{64}$/u);
      expect(candidate.rawContract.auth).toEqual({ kind: 'none', env: [] });
      expect(
        candidate.rawContract.rawInvocation.filter((arg) => arg === CLI_PROMPT_SENTINEL),
      ).toHaveLength(1);
    }
    expect(CLI_CONFORMANCE_CANDIDATES[0]?.contractSha256).not.toBe(
      CLI_CONFORMANCE_CANDIDATES[1]?.contractSha256,
    );
  });
});
