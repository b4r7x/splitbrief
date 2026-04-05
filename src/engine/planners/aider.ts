import type { PlannerBackend } from './types.js';
import { createPlannerBase, createIsAvailable, createGetVersion, type InvokeResult } from './base.js';
import { spawnAndCollect } from './spawn.js';
import { parseTextLine } from '../output-parsers.js';

const rawLineParse = (line: string) => ({ text: line + '\n' });

async function spawnAider(
  args: string[],
  projectDir: string,
  onOutput: (text: string) => void,
): Promise<InvokeResult> {
  let stderrOutput = '';

  const result = await spawnAndCollect({
    command: 'aider',
    args,
    cwd: projectDir,
    notFoundMessage: 'Aider not found. Install it from https://aider.chat',
    parseLine: rawLineParse,
    onOutput,
    onStderr: (chunk) => { stderrOutput += chunk; },
  });

  const allOutput = result.text + stderrOutput;
  for (const line of allOutput.split('\n')) {
    const parsed = parseTextLine(line);
    if (parsed.usage) {
      return { text: result.text.trim(), usage: parsed.usage };
    }
  }
  return { text: result.text.trim(), usage: result.usage };
}

function aiderAskArgs(model: string | undefined, prompt: string, readDirs?: string[]): string[] {
  const args = ['--chat-mode', 'ask', '--yes-always', '--no-stream', '--no-pretty', '--message', prompt];
  if (model) {
    args.unshift('--model', model);
  }
  if (readDirs) {
    for (const dir of readDirs) {
      args.push('--read', dir);
    }
  }
  return args;
}

export function createAiderPlanner(model?: string): PlannerBackend {

  return createPlannerBase({
    name: 'aider',
    pricingKey: 'aider',

    async invokePlan(prompt, projectDir, onOutput) {
      return spawnAider(aiderAskArgs(model, prompt, ['src/']), projectDir, onOutput);
    },

    async invokeEscalate(prompt, projectDir, onOutput) {
      return spawnAider(aiderAskArgs(model, prompt), projectDir, onOutput);
    },

    isAvailable: createIsAvailable('aider'),
    getVersion: createGetVersion('aider'),
  });
}
