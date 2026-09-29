import { describe, expect, it } from 'vitest';
import { matches } from '../../../utils/error.js';
import { claudeCodeImplementerAdapter } from './claude-code.js';
import { codexImplementerAdapter } from './codex.js';
import { opencodeImplementerAdapter } from './opencode.js';
import { CLI_PROMPT_SENTINEL } from './candidate-contract.js';
import { STRUCTURED_TERMINAL_TOOL_IDS } from '../../../core/config/load/validation/config.js';
import { CLI_IMPLEMENTER_ADAPTERS, CLI_PLANNER_ADAPTERS } from './registry.js';
import type { CliImplementerAdapter, CliProtocolEvent } from './contract.js';
import { withOutputFormat } from './output-format.js';

const isOutputFormatConflict = matches('cli-output-format-conflict');

function terminalFor(adapter: CliImplementerAdapter, events: readonly CliProtocolEvent[]) {
  return adapter.terminal({
    outputContract: adapter.outputContract,
    events,
    stderr: '',
    exitCode: 0,
    signal: null,
  });
}

function baseFor(adapter: CliImplementerAdapter) {
  return adapter.baseArgs({
    prompt: CLI_PROMPT_SENTINEL,
    model: undefined,
    projectDir: '.',
    configuredArgs: [],
  });
}

function expectFormatConflict(fn: () => unknown): void {
  let caught: unknown;
  try {
    fn();
    expect.unreachable('expected withOutputFormat to refuse the terminal downgrade');
  } catch (cause) {
    caught = cause;
  }
  expect(isOutputFormatConflict(caught)).toBe(true);
}

describe('withOutputFormat', () => {
  it('substitutes the text-exit parser for the format the backend can satisfy', () => {
    const adapter = withOutputFormat(opencodeImplementerAdapter, 'text');

    expect(opencodeImplementerAdapter.outputContract).toEqual({
      kind: 'text-exit',
      successfulExitCodes: [0],
    });
    expect(adapter.outputContract).toEqual({ kind: 'text-exit', successfulExitCodes: [0] });
    expect(terminalFor(adapter, adapter.parse('plain output line'))).toMatchObject({
      status: 'completed',
      error: null,
    });
  });

  it('finishes an explicit is_error result as failed instead of a non-fatal warning', () => {
    const adapter = withOutputFormat(opencodeImplementerAdapter, 'stream-json');
    const events = adapter.parse(
      JSON.stringify({ type: 'result', subtype: 'error', is_error: true, result: 'runner failed' }),
    );

    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'result',
        status: 'failed',
        error: { code: 'runner_result_error', message: 'runner failed' },
      }),
    );
    expect(terminalFor(adapter, events)).toMatchObject({
      status: 'failed',
      error: { code: 'runner_result_error', message: 'runner failed' },
    });
  });

  it('keeps stream-json rate-limit severities and never fabricates a terminal result', () => {
    const adapter = withOutputFormat(opencodeImplementerAdapter, 'stream-json');
    const parseRateFrame = (rateLimitInfo: Record<string, unknown>) =>
      adapter.parse(
        JSON.stringify({
          type: 'rate_limit_event',
          session_id: 'sess-rate',
          rate_limit_info: rateLimitInfo,
        }),
      );
    const warningsIn = (events: readonly CliProtocolEvent[]) =>
      events.filter((event) => event.type === 'warning');

    const allowed = parseRateFrame({
      status: 'allowed',
      overageStatus: 'rejected',
      rateLimitType: 'seven_day',
    });
    const approaching = parseRateFrame({ status: 'allowed_warning', rateLimitType: 'seven_day' });
    const rejected = parseRateFrame({ status: 'rejected', rateLimitType: 'five_hour' });
    const rateEvents = [...allowed, ...approaching, ...rejected];

    expect(warningsIn(allowed)).toEqual([]);
    expect(warningsIn(approaching)).toMatchObject([
      { code: 'claude_rate_limit', severity: 'warning' },
    ]);
    expect(warningsIn(rejected)).toMatchObject([{ code: 'claude_rate_limit', severity: 'error' }]);
    expect(rateEvents.some((event) => event.type === 'result')).toBe(false);
  });

  it('refuses to downgrade a required structured-terminal contract with user config', () => {
    expectFormatConflict(() => withOutputFormat(claudeCodeImplementerAdapter, 'text'));
    expectFormatConflict(() => withOutputFormat(codexImplementerAdapter, 'jsonl'));
    expectFormatConflict(() => withOutputFormat(claudeCodeImplementerAdapter, 'opencode'));

    expect(claudeCodeImplementerAdapter.outputContract).toEqual({
      kind: 'structured-terminal',
      terminalEvent: 'required',
    });
    expect(codexImplementerAdapter.outputContract).toEqual({
      kind: 'structured-terminal',
      terminalEvent: 'required',
    });
  });

  it('the tools config load refuses are exactly the structured-terminal adapters', () => {
    const structured = new Set(
      [...Object.values(CLI_PLANNER_ADAPTERS), ...Object.values(CLI_IMPLEMENTER_ADAPTERS)]
        .filter((adapter) => adapter.outputContract.kind === 'structured-terminal')
        .map((adapter) => adapter.descriptor.id),
    );

    expect([...structured].sort()).toEqual([...STRUCTURED_TERMINAL_TOOL_IDS]);
    expect([...STRUCTURED_TERMINAL_TOOL_IDS]).toEqual([
      'antigravity',
      'claude-code',
      'codex',
      'command-code',
      'cursor',
    ]);
  });

  it('rejects conflicting output flags and separator forms', () => {
    const base = baseFor(claudeCodeImplementerAdapter);
    const conflicting = [
      { tail: ['--output-format', 'text'], conflict: '--output-format' },
      { tail: ['--format=json'], conflict: '--format' },
      { tail: ['--print'], conflict: '--print' },
      { tail: ['--json'], conflict: '--json' },
      { tail: ['--', '--output-format', 'text'], conflict: '--output-format' },
    ];
    for (const { tail, conflict } of conflicting) {
      expect(
        claudeCodeImplementerAdapter.validateArgs({
          invocationArgs: [...base, ...tail],
          baseArgs: base,
        }),
      ).toEqual({ valid: false, conflicts: [conflict] });
    }
  });
});
