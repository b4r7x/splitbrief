import type { RunnerConfig } from '../../src/core/config/accessors/runner-config.js';
import type { CliToolId } from '../../src/core/runners/cli-tool/types.js';
import type {
  RunnerGate,
  RunnerSlot,
} from '../../src/engine/runners/prepare-execution/prepared.js';
import type { CliStartGate } from '../../src/engine/runners/start-gate.js';
import {
  createCliSeatGates,
  type CliSeat,
  type CliSeatGates,
  type RecheckCliTool,
} from '../../src/engine/runners/seat-gates.js';
import { executableReceipt } from './custom-command-based.js';

function unexpectedRecheck(tool: CliToolId): Error {
  return new Error(`The test did not expect a re-check of ${tool}.`);
}

/** A re-check the test did not set up: it fails the call loudly instead of admitting anything. */
export const unexpectedCliRecheck: RecheckCliTool = async (tool) => {
  throw unexpectedRecheck(tool);
};

/** The run's CLI seats over `gates`, as preparation builds them, with a re-check that fails the test. */
export function testCliSeats(gates: readonly RunnerGate[]): CliSeatGates {
  return createCliSeatGates({ gates, recheck: unexpectedCliRecheck });
}

/** The seat a directly built CLI adapter calls through: it starts `gate`, and a re-check fails the test. */
export function admittedCliSeat(gate: CliStartGate): CliSeat {
  return {
    tool: gate.tool,
    current: () => gate,
    recheck: async () => {
      throw unexpectedRecheck(gate.tool);
    },
  };
}

export function makeRunnerGate(
  runner: RunnerConfig,
  slot: RunnerSlot,
  preparationId: string,
): RunnerGate {
  const base = { slot, preparationId };
  switch (runner.kind) {
    case 'cli':
      return { ...base, kind: 'cli', tool: runner.tool, executable: executableReceipt() };
    case 'api':
      return {
        ...base,
        kind: 'api',
        provider: runner.provider,
        endpointOrigin: new URL(runner.apiBase).origin,
      };
    case 'shell':
      return { ...base, kind: 'shell', command: { kind: 'validated-config' } };
    case 'agent':
      return { ...base, kind: 'agent', command: { kind: 'validated-config' } };
  }
}
