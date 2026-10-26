import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { EffortLevel } from '../../../core/schemas/enums.js';
import {
  ANTIGRAVITY_CLI_ADMISSION_VERDICT,
  CLI_TOOL_CATALOG,
} from '../../../core/runners/cli-tool-catalog.js';
import { classifyCliAdmittedVersion } from '../../../core/runners/cli-version.js';
import { CLI_PROJECT_DIR_SENTINEL, CLI_PROMPT_SENTINEL } from './candidate-contract.js';
import type { CliSchemaInput } from './contract.js';
import { contractSha256 } from '../../providers/candidate-contract.js';
import {
  CLI_CONFORMANCE_CANDIDATES,
  antigravityImplementerAdapter,
  antigravityPlannerAdapter,
  antigravityProtocolEvents,
} from './antigravity.js';

const PROMPT = CLI_PROMPT_SENTINEL;
// Re-pinned 2026-10-26: both contracts read the prompt as one stream-json line on stdin.
const ANTIGRAVITY_PLANNER_CONTRACT_SHA256 =
  'adacd9ff5406d56d98051d438e4321f0b96991d34e2e969a22a48832717e51ef';
const ANTIGRAVITY_IMPLEMENTER_CONTRACT_SHA256 =
  'cbbe550b71df9fd952b68768df7c6de3197cdc387786141854cf7b27d3339666';
const STREAM_JSON_FIXTURE = join(
  import.meta.dirname,
  '../../../../testing/fixtures/antigravity/stream-json.ndjson',
);

function fixtureEvents() {
  return readFileSync(STREAM_JSON_FIXTURE, 'utf8')
    .split('\n')
    .filter((line) => line.length > 0)
    .flatMap((line) => [...antigravityProtocolEvents(line)]);
}

function plannerArgs(
  options: {
    model?: string | undefined;
    configuredArgs?: readonly string[];
    effort?: EffortLevel | undefined;
    schema?: CliSchemaInput | undefined;
  } = {},
) {
  return antigravityPlannerAdapter.buildArgs({
    model: options.model,
    projectDir: '/project',
    configuredArgs: options.configuredArgs ?? [],
    sessionId: null,
    effort: options.effort,
    schema: options.schema,
  });
}

function implementerArgs(
  options: {
    model?: string | undefined;
    configuredArgs?: readonly string[];
    effort?: EffortLevel | undefined;
    schema?: CliSchemaInput | undefined;
  } = {},
) {
  return antigravityImplementerAdapter.buildArgs({
    model: options.model,
    projectDir: '/staged',
    configuredArgs: options.configuredArgs ?? [],
    effort: options.effort,
    schema: options.schema,
  });
}

describe('Antigravity role adapters', () => {
  it('is an admitted catalog tool with the agy binary and model-id effort', () => {
    expect(ANTIGRAVITY_CLI_ADMISSION_VERDICT).toBe('PASS');
    expect(CLI_TOOL_CATALOG.antigravity.command).toBe('agy');
    expect(CLI_TOOL_CATALOG.antigravity.executableAliases).toEqual(['agy']);
    expect(CLI_TOOL_CATALOG.antigravity.effortChannel).toBe('model-id');
    expect(antigravityPlannerAdapter.supportsEffort).toBe(false);
    expect(CLI_TOOL_CATALOG.antigravity.compatibility.versionScheme).toBe('semver');
    expect(CLI_TOOL_CATALOG.antigravity.compatibility.testedVersion).toBe('1.4.7');
    expect(CLI_TOOL_CATALOG.antigravity.compatibility.evidence.asOf).toBe('2026-10-24');
  });

  it('admits agy from 1.3.2, where the skip-permissions flag no longer approves a plan-mode plan', () => {
    const { minimumAdmittedVersion } = CLI_TOOL_CATALOG.antigravity.compatibility;
    expect(classifyCliAdmittedVersion({ installedVersion: '1.3.1', minimumAdmittedVersion })).toBe(
      'incompatible',
    );
    expect(classifyCliAdmittedVersion({ installedVersion: '1.3.2', minimumAdmittedVersion })).toBe(
      'compatible',
    );
  });

  it('probes the version with --version, the flag that prints the bare semver', () => {
    expect(antigravityPlannerAdapter.probe?.version.command).toEqual(['agy', '--version']);
    expect(antigravityImplementerAdapter.probe?.version.command).toEqual(['agy', '--version']);
  });

  it("runs the planner in plan mode inside agy's terminal sandbox, so read-only commands need no prompt", () => {
    expect(plannerArgs({ model: 'gemini-3.8-flash-low' })).toEqual([
      '--input-format',
      'stream-json',
      '--mode',
      'plan',
      '--sandbox',
      '--dangerously-skip-permissions',
      '--add-dir',
      '/project',
      '--output-format',
      'stream-json',
      '--model',
      'gemini-3.8-flash-low',
    ]);
  });

  it.each([plannerArgs, implementerArgs])(
    'sends only the model id when an old config also carries an effort',
    (args) => {
      const argv = args({ model: 'gemini-3.8-flash-high', effort: 'low' });
      expect(argv.slice(-2)).toEqual(['--model', 'gemini-3.8-flash-high']);
      expect(argv).not.toContain('--effort');
      expect(args({ effort: 'low' })).not.toContain('--effort');
    },
  );

  it('builds the implementer argv with the write flag', () => {
    expect(implementerArgs()).toEqual([
      '--input-format',
      'stream-json',
      '--dangerously-skip-permissions',
      '--add-dir',
      '/staged',
      '--output-format',
      'stream-json',
    ]);
  });

  it('appends the inline schema after the planner generation args, and nothing without one', () => {
    const schema = { json: { type: 'object' } };
    expect(plannerArgs({ schema })).toEqual([
      '--input-format',
      'stream-json',
      '--mode',
      'plan',
      '--sandbox',
      '--dangerously-skip-permissions',
      '--add-dir',
      '/project',
      '--output-format',
      'stream-json',
      '--json-schema',
      '{"type":"object"}',
    ]);
    expect(plannerArgs()).toEqual([
      '--input-format',
      'stream-json',
      '--mode',
      'plan',
      '--sandbox',
      '--dangerously-skip-permissions',
      '--add-dir',
      '/project',
      '--output-format',
      'stream-json',
    ]);
  });

  it('appends the inline schema after the implementer generation args, and nothing without one', () => {
    expect(implementerArgs({ schema: { json: { type: 'object' } } })).toEqual([
      '--input-format',
      'stream-json',
      '--dangerously-skip-permissions',
      '--add-dir',
      '/staged',
      '--output-format',
      'stream-json',
      '--json-schema',
      '{"type":"object"}',
    ]);
    expect(implementerArgs()).toEqual([
      '--input-format',
      'stream-json',
      '--dangerously-skip-permissions',
      '--add-dir',
      '/staged',
      '--output-format',
      'stream-json',
    ]);
  });

  it('refuses a configured --json-schema that would override the adapter schema', () => {
    const baseArgs = plannerArgs();
    expect(
      antigravityPlannerAdapter.validateArgs({
        invocationArgs: [...baseArgs, '--json-schema', '{}'],
        baseArgs,
      }),
    ).toEqual({ valid: false, conflicts: ['--json-schema'] });
  });

  // `agy -p` does not make its cwd a workspace, so the model is told it has none and runs
  // its commands in `~/.gemini/antigravity-cli/scratch`; `--add-dir` is what names one.
  it('names the seat directory as the agy workspace on both seats', () => {
    for (const [args, dir] of [
      [plannerArgs(), '/project'],
      [implementerArgs(), '/staged'],
    ] as const) {
      expect(args[args.indexOf('--add-dir') + 1]).toBe(dir);
      expect(args.filter((arg) => arg === '--add-dir')).toHaveLength(1);
    }
  });

  it('asks both seats for the stream-json protocol so every step reaches the transcript', () => {
    for (const args of [plannerArgs(), implementerArgs()]) {
      expect(args[args.indexOf('--output-format') + 1]).toBe('stream-json');
    }
  });

  it('replays the captured stream: session, paired tool steps, streamed text, per-step usage', () => {
    const events = fixtureEvents();
    const tools = events.filter((event) => event.type === 'tool-use');
    const terminal = antigravityImplementerAdapter.terminal({
      outputContract: antigravityImplementerAdapter.outputContract,
      events,
      stderr: '',
      exitCode: 0,
      signal: null,
    });

    expect(events[0]).toEqual({
      type: 'session',
      nativeSessionId: '50328626-c5df-4301-9da7-dee7ce900271',
    });
    expect(tools.map((event) => [event.id, event.stage])).toEqual([
      ['step-2', 'started'],
      ['step-2', 'done'],
      ['step-4', 'started'],
      ['step-4', 'done'],
      ['step-6', 'started'],
      ['step-6', 'done'],
    ]);
    const streamed = events
      .flatMap((event) => (event.type === 'text' ? [event.text] : []))
      .join('');
    const semantics = events
      .filter((event) => event.type === 'usage')
      .map((event) => event.semantics);
    expect(streamed).toBe('OK\n');
    expect(semantics).toEqual(['delta', 'delta', 'delta', 'delta']);
    expect(terminal).toEqual({
      type: 'result',
      status: 'completed',
      text: 'OK\n',
      usage: {
        inputTokens: 59864,
        outputTokens: 272,
        reasoningTokens: 999,
        cacheReadTokens: 0,
        counterCoverage: {
          input: 'reported',
          output: 'reported',
          cacheRead: 'reported',
          cacheCreate: 'missing',
          reasoning: 'reported',
        },
      },
      nativeSessionId: '50328626-c5df-4301-9da7-dee7ce900271',
      error: null,
      partial: false,
    });
  });

  it('hands back the result response as the text of both seats', () => {
    const events = fixtureEvents();
    for (const adapter of [antigravityPlannerAdapter, antigravityImplementerAdapter]) {
      expect(
        adapter.terminal({
          outputContract: adapter.outputContract,
          events,
          stderr: '',
          exitCode: 0,
          signal: null,
        }).text,
      ).toBe('OK\n');
    }
  });

  it('fails a non-SUCCESS result instead of completing on the exit code', () => {
    const events = antigravityProtocolEvents(
      JSON.stringify({
        event: 'result',
        result: { conversation_id: 'conv-1', status: 'ERROR', error: 'quota reached' },
      }),
    );

    expect(
      antigravityImplementerAdapter.terminal({
        outputContract: antigravityImplementerAdapter.outputContract,
        events,
        stderr: '',
        exitCode: 0,
        signal: null,
      }),
    ).toMatchObject({
      status: 'failed',
      nativeSessionId: 'conv-1',
      error: { code: 'antigravity-result-failed', message: 'quota reached' },
      partial: true,
    });
  });

  it('appends configured args after the adapter-owned prefix', () => {
    expect(implementerArgs({ configuredArgs: ['--verbose'] }).at(-1)).toBe('--verbose');
  });

  it.each([
    ['--mode', 'plan'],
    ['--dangerously-skip-permissions'],
    ['--sandbox'],
    ['--output-format', 'text'],
    ['--print-timeout', '1m'],
    ['--model', 'other'],
    ['--effort', 'low'],
    ['--add-dir', '/elsewhere'],
  ])('refuses a configured %s that overrides adapter authority', (...configured) => {
    const baseArgs = implementerArgs();
    expect(
      antigravityImplementerAdapter.validateArgs({
        invocationArgs: [...baseArgs, ...configured],
        baseArgs,
      }),
    ).toMatchObject({ valid: false });
  });

  it('requires the result frame as the terminal on both seats', () => {
    for (const adapter of [antigravityPlannerAdapter, antigravityImplementerAdapter]) {
      expect(adapter.outputContract).toEqual({
        kind: 'structured-terminal',
        terminalEvent: 'required',
      });
      expect(() =>
        adapter.terminal({
          outputContract: adapter.outputContract,
          events: antigravityProtocolEvents('{"event":"init","conversation_id":"conv-1"}'),
          stderr: '',
          exitCode: 0,
          signal: null,
        }),
      ).toThrow('Antigravity output ended without a terminal result');
    }
  });

  it('publishes one conformance candidate per seat, each hashing its own raw contract', () => {
    expect(CLI_CONFORMANCE_CANDIDATES.map((candidate) => candidate.role)).toEqual([
      'planner',
      'implementer',
    ]);
    for (const candidate of CLI_CONFORMANCE_CANDIDATES) {
      expect(contractSha256(candidate.rawContract)).toBe(candidate.contractSha256);
      expect(candidate.rawContract.expectedRawTerminal).toBe('result');
      expect(candidate.rawContract.asOf).toBe('2026-09-23');
      expect(candidate.rawContract.promptTransport).toBe('stdin');
      expect(candidate.rawContract.rawInvocation).not.toContain(PROMPT);
      expect(candidate.rawContract.rawInvocation.slice(0, 2)).toEqual([
        '--input-format',
        'stream-json',
      ]);
      expect(candidate.rawContract.rawInvocation.slice(-4)).toEqual([
        '--add-dir',
        CLI_PROJECT_DIR_SENTINEL,
        '--output-format',
        'stream-json',
      ]);
    }
    expect(CLI_CONFORMANCE_CANDIDATES[0]?.contractSha256).toBe(ANTIGRAVITY_PLANNER_CONTRACT_SHA256);
    expect(CLI_CONFORMANCE_CANDIDATES[1]?.contractSha256).toBe(
      ANTIGRAVITY_IMPLEMENTER_CONTRACT_SHA256,
    );
    expect(CLI_CONFORMANCE_CANDIDATES[0]?.contractSha256).not.toBe(
      CLI_CONFORMANCE_CANDIDATES[1]?.contractSha256,
    );
  });
});
