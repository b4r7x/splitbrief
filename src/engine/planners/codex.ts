import type { PlannerBackend } from './types.js';
import { createPlannerBase, createIsAvailable, createGetVersion } from './base.js';
import type { InvokeResult } from './base.js';
import { spawnAndCollect } from './spawn.js';
import { parseJsonlLine } from '../output-parsers.js';

const NOT_FOUND = 'Codex CLI not found. Install it with: npm install -g @openai/codex';

async function spawnCodex(
  model: string | undefined,
  prompt: string,
  projectDir: string,
  onOutput: (text: string) => void,
): Promise<InvokeResult> {
  const args = ['exec', '--json', '--full-auto', '--cd', projectDir, prompt];
  if (model) {
    args.unshift('--model', model);
  }
  return spawnAndCollect({
    command: 'codex',
    args,
    cwd: projectDir,
    notFoundMessage: NOT_FOUND,
    parseLine: parseJsonlLine,
    onOutput,
  });
}

export function createCodexPlanner(model?: string): PlannerBackend {

  return createPlannerBase({
    name: 'codex',
    pricingKey: 'codex',

    async invokePlan(prompt, projectDir, onOutput) {
      return spawnCodex(model, prompt, projectDir, onOutput);
    },

    async invokeEscalate(prompt, projectDir, onOutput) {
      return spawnCodex(model, prompt, projectDir, onOutput);
    },

    isAvailable: createIsAvailable('codex'),
    getVersion: createGetVersion('codex'),
  });
}
