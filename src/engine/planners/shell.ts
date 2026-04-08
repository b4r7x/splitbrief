import type { Config, OutputFormat } from '../../types.js';
import type { Planner } from './types.js';
import { createPlannerBase, createIsAvailable } from './base.js';
import type { InvokeResult } from './base.js';
import { spawnAndCollect } from '../../utils/process.js';
import { getLineParser } from '../streaming/output-parsers.js';

async function spawnShellCommand(
  prompt: string,
  projectDir: string,
  opts: {
    command: string;
    args: string[];
    format: OutputFormat;
    onOutput: (text: string) => void;
  },
): Promise<InvokeResult> {
  const { command, args, format, onOutput } = opts;
  return spawnAndCollect({
    command,
    args,
    cwd: projectDir,
    stdin: prompt,
    notFoundMessage: `Shell planner command not found: ${command}`,
    parseLine: getLineParser(format),
    onOutput,
  });
}

export function createShellPlanner(config: Config): Planner {
  const command = config.planner.command!;
  const baseArgs = config.planner.args ?? [];
  const format: OutputFormat = config.planner.outputFormat ?? 'text';

  return createPlannerBase({
    name: `shell:${command}`,
    pricingKey: 'shell',

    async invokePlan(prompt, projectDir, onOutput) {
      return spawnShellCommand(prompt, projectDir, {
        command, args: baseArgs, format, onOutput,
      });
    },

    async invokeEscalate(prompt, projectDir, onOutput) {
      return spawnShellCommand(prompt, projectDir, {
        command, args: baseArgs, format, onOutput,
      });
    },

    isAvailable: createIsAvailable(command),

    async getVersion() {
      return null;
    },
  });
}
