import type { Config } from '../schemas/config.js';
import type { DiscoveredValidation } from '../schemas/workflow.js';
import { parseShellCommand } from '../../utils/parse-shell-command.js';
import type { ManifestCommands } from './manifest-commands.js';
import type { Stack } from './stacks/types.js';

export type CommandSource = 'config' | 'manifest' | 'discovered' | 'default';

export interface ResolvedCommand {
  cmd: string;
  args: string[];
  source: CommandSource;
}

export type TestCommandResolution = {
  config: Config;
  manifest: ManifestCommands;
  discovered: DiscoveredValidation | undefined;
  stack: Stack | null;
  projectDir: string;
};

/** The command a planner `test` check runs: config, then the manifest, the planner, the stack. */
export function resolveTestCommand(opts: TestCommandResolution): ResolvedCommand | null {
  const { config, manifest, discovered, stack, projectDir } = opts;
  const chain: ReadonlyArray<readonly [CommandSource, string | null | undefined]> = [
    ['config', config.validation.testCommand],
    ['manifest', manifest.test],
    ['discovered', discovered?.testCommand],
    ['default', stack === null ? null : stack.test(projectDir)],
  ];
  for (const [source, value] of chain) {
    if (!value) continue;
    const parts = parseShellCommand(value);
    const cmd = parts[0];
    if (!cmd) continue;
    return { cmd, args: parts.slice(1), source };
  }
  return null;
}
