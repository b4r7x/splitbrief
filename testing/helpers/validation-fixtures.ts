import { createDefaultConfig } from '../../src/core/config/load/io.js';
import type { Config } from '../../src/core/schemas/config.js';
import type { ValidationCommandRunner } from '../../src/engine/orchestrator/validation/types.js';

export function makeConfig(overrides: Partial<Config['validation']>): Config {
  const base = createDefaultConfig();
  return { ...base, validation: { ...base.validation, ...overrides } };
}

type CommandResult = Awaited<ReturnType<ValidationCommandRunner>>;
type CommandCall = {
  cmd: string;
  args: string[];
  options: Parameters<ValidationCommandRunner>[2];
};
export type RecordingCommandRunner = ValidationCommandRunner & { calls: CommandCall[] };

export function makeCommandRunner(...script: Array<CommandResult | Error>): RecordingCommandRunner {
  let index = 0;
  const calls: CommandCall[] = [];
  const runner = (async (cmd, args, options) => {
    calls.push({ cmd, args, options });
    const next = script[index];
    index += 1;
    if (next instanceof Error) throw next;
    return next ?? { stdout: [cmd, ...args].join(' '), stderr: '', code: 0 };
  }) as RecordingCommandRunner;
  runner.calls = calls;
  return runner;
}
