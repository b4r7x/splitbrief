import type { PlannerTokenUsage } from '../../types.js';
import type { Planner } from './types.js';
import { createPlannerBase, createIsAvailable, createGetVersion, type InvokeResult } from './base.js';
import { spawnAndCollect } from '../../utils/process.js';
import { parseJsonlLine, parseOpencodeLine, parseTextLine } from '../streaming/output-parsers.js';

export type CliPlannerKind = 'codex' | 'opencode' | 'aider';

interface ParsedLine {
  text?: string;
  usage?: PlannerTokenUsage;
}

interface CliPlannerSpec {
  cmd: string;
  pricingKey: string;
  notFound: string;
  buildArgs: (model: string | undefined, prompt: string, projectDir: string, mode: 'plan' | 'escalate') => string[];
  parseLine: (line: string) => ParsedLine;
  postProcess?: (text: string, stderrOutput: string, usage: PlannerTokenUsage | null) => InvokeResult;
  isAvailableOpts?: { timeout?: number };
}

const SPECS: Record<CliPlannerKind, CliPlannerSpec> = {
  codex: {
    cmd: 'codex',
    pricingKey: 'codex',
    notFound: 'Codex CLI not found. Install it with: npm install -g @openai/codex',
    buildArgs: (model, prompt, projectDir) => {
      const args = ['exec', '--json', '--full-auto', '--cd', projectDir, prompt];
      if (model) args.unshift('--model', model);
      return args;
    },
    parseLine: parseJsonlLine,
  },
  opencode: {
    cmd: 'opencode',
    pricingKey: 'opencode',
    notFound: 'OpenCode CLI not found. Install it from https://github.com/nicholasoxford/opencode',
    buildArgs: (model, prompt) => {
      const args = ['run', '--format', 'json', '--agent', 'plan', prompt];
      if (model) args.splice(1, 0, '--model', model);
      return args;
    },
    parseLine: parseOpencodeLine,
    isAvailableOpts: { timeout: 5000 },
  },
  aider: {
    cmd: 'aider',
    pricingKey: 'aider',
    notFound: 'Aider not found. Install it from https://aider.chat',
    buildArgs: (model, prompt, _projectDir, mode) => {
      const args = ['--chat-mode', 'ask', '--yes-always', '--no-stream', '--no-pretty', '--message', prompt];
      if (model) args.unshift('--model', model);
      if (mode === 'plan') args.push('--read', 'src/');
      return args;
    },
    parseLine: (line) => ({ text: line + '\n' }),
    postProcess: (text, stderrOutput, usage) => {
      const allOutput = text + stderrOutput;
      for (const line of allOutput.split('\n')) {
        const parsed = parseTextLine(line);
        if (parsed.usage) return { text: text.trim(), usage: parsed.usage };
      }
      return { text: text.trim(), usage };
    },
  },
};

export function createCliPlanner(kind: CliPlannerKind, model?: string): Planner {
  const spec = SPECS[kind];

  async function invoke(
    prompt: string,
    projectDir: string,
    onOutput: (text: string) => void,
    mode: 'plan' | 'escalate',
  ): Promise<InvokeResult> {
    let stderrOutput = '';
    const result = await spawnAndCollect({
      command: spec.cmd,
      args: spec.buildArgs(model, prompt, projectDir, mode),
      cwd: projectDir,
      notFoundMessage: spec.notFound,
      parseLine: spec.parseLine,
      onOutput,
      onStderr: spec.postProcess ? (chunk) => { stderrOutput += chunk; } : undefined,
    });

    if (spec.postProcess) return spec.postProcess(result.text, stderrOutput, result.usage);
    return result;
  }

  return createPlannerBase({
    name: kind,
    pricingKey: spec.pricingKey,

    invokePlan: (prompt, projectDir, onOutput) => invoke(prompt, projectDir, onOutput, 'plan'),
    invokeEscalate: (prompt, projectDir, onOutput) => invoke(prompt, projectDir, onOutput, 'escalate'),

    isAvailable: createIsAvailable(spec.cmd, spec.isAvailableOpts),
    getVersion: createGetVersion(spec.cmd),
  });
}
