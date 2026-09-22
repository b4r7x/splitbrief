import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { EffortLevel } from '../../../core/schemas/enums.js';
import {
  ANTIGRAVITY_CLI_ADMISSION_VERDICT,
  CLI_TOOL_CATALOG,
} from '../../../core/runners/cli-tool-catalog.js';
import { CLI_PROMPT_SENTINEL } from './candidate-contract.js';
import { contractSha256 } from '../../providers/candidate-contract.js';
import {
  CLI_CONFORMANCE_CANDIDATES,
  antigravityImplementerAdapter,
  antigravityPlannerAdapter,
  antigravityProtocolEvents,
} from './antigravity.js';

const PROMPT = CLI_PROMPT_SENTINEL;
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
  } = {},
) {
  return antigravityPlannerAdapter.buildArgs({
    prompt: PROMPT,
    model: options.model,
    projectDir: '/project',
    configuredArgs: options.configuredArgs ?? [],
    mode: 'plan',
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
  return antigravityImplementerAdapter.buildArgs({
    prompt: PROMPT,
    model: options.model,
    projectDir: '/staged',
    configuredArgs: options.configuredArgs ?? [],
    effort: options.effort,
  });
}

describe('Antigravity role adapters', () => {
  it('is an admitted catalog tool with the agy binary and an effort flag', () => {
    expect(ANTIGRAVITY_CLI_ADMISSION_VERDICT).toBe('PASS');
    expect(CLI_TOOL_CATALOG.antigravity.command).toBe('agy');
    expect(CLI_TOOL_CATALOG.antigravity.executableAliases).toEqual(['agy']);
    expect(CLI_TOOL_CATALOG.antigravity.effortChannel).toBe('effort-flag');
    expect(CLI_TOOL_CATALOG.antigravity.compatibility.versionScheme).toBe('semver');
    expect(CLI_TOOL_CATALOG.antigravity.compatibility.testedVersion).toBe('1.2.7');
    expect(CLI_TOOL_CATALOG.antigravity.compatibility.evidence.asOf).toBe('2026-09-21');
  });

  it('probes the version with --version, the flag that prints the bare semver', () => {
    expect(antigravityPlannerAdapter.probe?.version.command).toEqual(['agy', '--version']);
    expect(antigravityImplementerAdapter.probe?.version.command).toEqual(['agy', '--version']);
  });

  it('builds the planner argv with the read-only plan mode and the 10-minute deadline', () => {
    expect(plannerArgs({ model: 'gemini-3-pro', effort: 'high' })).toEqual([
      '-p',
      PROMPT,
      '--mode',
      'plan',
      '--print-timeout',
      '10m',
      '--output-format',
      'stream-json',
      '--model',
      'gemini-3-pro',
      '--effort',
      'high',
    ]);
  });

  it('builds the implementer argv with the write flag and the 20-minute deadline', () => {
    expect(implementerArgs()).toEqual([
      '-p',
      PROMPT,
      '--dangerously-skip-permissions',
      '--print-timeout',
      '20m',
      '--output-format',
      'stream-json',
    ]);
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
      usage: { inputTokens: 59864, outputTokens: 272, reasoningTokens: 999, cacheReadTokens: 0 },
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
    ['--output-format', 'text'],
    ['--print-timeout', '1m'],
    ['--model', 'other'],
    ['--effort', 'low'],
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
      expect(candidate.rawContract.asOf).toBe('2026-09-21');
      expect(candidate.rawContract.rawInvocation.slice(-2)).toEqual([
        '--output-format',
        'stream-json',
      ]);
    }
    expect(CLI_CONFORMANCE_CANDIDATES[0]?.contractSha256).not.toBe(
      CLI_CONFORMANCE_CANDIDATES[1]?.contractSha256,
    );
  });
});
