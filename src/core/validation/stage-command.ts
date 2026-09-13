import type { Config } from '../schemas/config.js';
import type { ValidationStage } from '../schemas/enums.js';
import type { DiscoveredValidation } from '../schemas/workflow.js';
import { parseShellCommand } from '../../utils/parse-shell-command.js';
import type { ManifestCommands } from './manifest-commands.js';
import type { Stack } from './stacks/types.js';

type CommandField = 'typecheckCommand' | 'lintCommand' | 'testCommand';

export type CommandSource = 'config' | 'manifest' | 'discovered' | 'default';

export interface ResolvedCommand {
  cmd: string;
  args: string[];
  source: CommandSource;
}

export type StageResolution = {
  stage: ValidationStage;
  config: Config;
  manifest: ManifestCommands;
  discovered: DiscoveredValidation | undefined;
  stack: Stack | null;
  projectDir: string;
};

const STAGE_FIELD: Readonly<Record<ValidationStage, CommandField>> = {
  typecheck: 'typecheckCommand',
  lint: 'lintCommand',
  test: 'testCommand',
};

export function resolveStageCommand(opts: StageResolution): ResolvedCommand | null {
  const { stage, config, manifest, discovered, stack, projectDir } = opts;
  const field = STAGE_FIELD[stage];
  const chain: ReadonlyArray<readonly [CommandSource, string | null | undefined]> = [
    ['config', config.validation[field]],
    ['manifest', manifest[stage]],
    ['discovered', discovered?.[field]],
    ['default', stack === null ? null : stack[stage](projectDir)],
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

export function isMissingSubcommand(
  stack: Stack | null | undefined,
  code: number | null,
  stderr: string,
): boolean {
  const signature = stack?.missingSubcommand;
  if (signature === undefined) return false;
  return code === signature.exitCode && signature.stderr.test(stderr);
}
