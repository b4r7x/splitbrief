import type { RunnerConfig } from '../../src/core/config/accessors/runner-config.js';
import type { RunnerGate, RunnerSlot } from '../../src/engine/runners/prepared-execution.js';
import { executableReceipt } from './custom-command-based.js';

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
    case 'agent-sdk':
      return { ...base, kind: 'agent-sdk', provider: 'anthropic' };
    case 'shell':
      return { ...base, kind: 'shell', command: { kind: 'validated-config' } };
    case 'agent':
      return { ...base, kind: 'agent', command: { kind: 'validated-config' } };
  }
}
