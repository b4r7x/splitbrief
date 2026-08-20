import { describe, expect, it } from 'vitest';
import { matches } from '../../../utils/error.js';
import { claudeCodeImplementerAdapter } from './claude-code.js';
import { codexImplementerAdapter } from './codex.js';
import { opencodeImplementerAdapter } from './opencode.js';
import { CLI_PROMPT_SENTINEL } from './candidate-contract.js';
import type { CliImplementerAdapter, CliProtocolEvent } from './contract.js';
import { withOutputFormat } from './output-format.js';

const isOutputFormatConflict = matches('cli-output-format-conflict');

function terminalFor(adapter: CliImplementerAdapter, events: readonly CliProtocolEvent[]) {
  return adapter.terminal({
    outputContract: adapter.outputContract,
    events,
    stdout: '',
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

  it('rejects conflicting output flags and separator forms with zero spawn', () => {
    const base = baseFor(claudeCodeImplementerAdapter);
    const conflicting = [
      [...base, '--output-format', 'text'],
      [...base, '--format=json'],
      [...base, '--print'],
      [...base, '--json'],
      [...base, '--', '--output-format', 'text'],
    ];
    for (const args of conflicting) {
      let spawns = 0;
      const verdict = claudeCodeImplementerAdapter.validateArgs(args, base);
      if (verdict.valid) spawns += 1;
      expect(verdict.valid).toBe(false);
      expect(spawns).toBe(0);
    }
  });
});
