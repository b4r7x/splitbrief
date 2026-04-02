import type { PlannerBackend } from './types.js';
import { createPlannerBase, createIsAvailable, createGetVersion } from './base.js';
import type { InvokeResult } from './base.js';
import { spawnAndCollect } from './spawn.js';
import { parseOpencodeLine } from '../output-parsers.js';

async function spawnOpenCode(
  agent: string,
  prompt: string,
  projectDir: string,
  onOutput: (text: string) => void,
): Promise<InvokeResult> {
  return spawnAndCollect({
    command: 'opencode',
    args: ['run', '--format', 'json', '--agent', agent, prompt],
    cwd: projectDir,
    notFoundMessage: 'OpenCode CLI not found. Install it from https://github.com/nicholasoxford/opencode',
    parseLine: parseOpencodeLine,
    onOutput,
  });
}

export function createOpenCodePlanner(): PlannerBackend {
  return createPlannerBase({
    name: 'opencode',
    pricingKey: 'opencode',

    async invokePlan(prompt, projectDir, onOutput) {
      return spawnOpenCode('plan', prompt, projectDir, onOutput);
    },

    async invokeEscalate(prompt, projectDir, onOutput) {
      return spawnOpenCode('plan', prompt, projectDir, onOutput);
    },

    isAvailable: createIsAvailable('opencode', { timeout: 5000 }),
    getVersion: createGetVersion('opencode'),
  });
}
