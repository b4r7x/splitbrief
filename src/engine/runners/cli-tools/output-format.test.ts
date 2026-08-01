import { describe, expect, it } from 'vitest';
import { claudeCodeImplementerAdapter } from './claude-code.js';
import type { CliImplementerAdapter, CliProtocolEvent } from './contract.js';
import { withOutputFormat } from './output-format.js';

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

describe('withOutputFormat', () => {
  it('replaces the structured-terminal contract the substituted parser can never satisfy', () => {
    const adapter = withOutputFormat(claudeCodeImplementerAdapter, 'text');

    expect(claudeCodeImplementerAdapter.outputContract).toEqual({
      kind: 'structured-terminal',
      terminalEvent: 'required',
    });
    expect(adapter.outputContract).toEqual({ kind: 'text-exit', successfulExitCodes: [0] });
    expect(terminalFor(adapter, adapter.parse('plain output line'))).toMatchObject({
      status: 'completed',
      error: null,
    });
  });

  it('finishes an explicit is_error result as failed instead of a non-fatal warning', () => {
    const adapter = withOutputFormat(claudeCodeImplementerAdapter, 'stream-json');
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
});
