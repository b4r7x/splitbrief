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
    expect(CLI_TOOL_CATALOG.antigravity.compatibility.testedVersion).toBe('1.2.2');
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
    ]);
  });

  it('asks for no output format, because both seats read the stream with the text parser', () => {
    expect(plannerArgs()).not.toContain('--output-format');
    expect(implementerArgs()).not.toContain('--output-format');
  });

  it('books the prose token line as the running total, not a delta to add up', () => {
    const events = [
      ...antigravityProtocolEvents('Tokens: 1.2k sent, 300 received'),
      ...antigravityProtocolEvents('Tokens: 1.5k sent, 400 received'),
    ];

    expect(events).toEqual([
      { type: 'usage', usage: { inputTokens: 1200, outputTokens: 300 }, semantics: 'final' },
      { type: 'usage', usage: { inputTokens: 1500, outputTokens: 400 }, semantics: 'final' },
    ]);
    expect(
      antigravityImplementerAdapter.terminal({
        outputContract: antigravityImplementerAdapter.outputContract,
        events,
        stderr: '',
        exitCode: 0,
        signal: null,
      }).usage,
    ).toMatchObject({ inputTokens: 1500, outputTokens: 400 });
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

  it('parses text lines and closes on the process exit contract', () => {
    expect(antigravityPlannerAdapter.outputContract).toEqual({
      kind: 'text-exit',
      successfulExitCodes: [0],
    });
    const events = [...antigravityProtocolEvents('the plan')];
    const terminal = antigravityPlannerAdapter.terminal({
      outputContract: antigravityPlannerAdapter.outputContract,
      events,
      stderr: '',
      exitCode: 0,
      signal: null,
    });

    expect(terminal).toMatchObject({ type: 'result', status: 'completed', text: 'the plan\n' });
  });

  it('publishes one conformance candidate per seat, each hashing its own raw contract', () => {
    expect(CLI_CONFORMANCE_CANDIDATES.map((candidate) => candidate.role)).toEqual([
      'planner',
      'implementer',
    ]);
    for (const candidate of CLI_CONFORMANCE_CANDIDATES) {
      expect(contractSha256(candidate.rawContract)).toBe(candidate.contractSha256);
      expect(candidate.rawContract.expectedRawTerminal).toBe('process-exit');
    }
    expect(CLI_CONFORMANCE_CANDIDATES[0]?.contractSha256).not.toBe(
      CLI_CONFORMANCE_CANDIDATES[1]?.contractSha256,
    );
  });
});
