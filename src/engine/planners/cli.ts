import type { PlannerTokenUsage } from '../../types.js';
import type { Planner } from './types.js';
import { createPlannerBase, createIsAvailable, createGetVersion, type InvokeResult } from './base.js';
import { spawnAndCollect } from './spawn-collect.js';
import { parseJsonlLine, parseOpencodeLine, parseTextLine } from '../streaming/output-parsers.js';
import { CLI_TOOLS, type CliToolName } from '../cli-tools.js';

type CliPlannerKind = CliToolName;

interface ParsedLine {
  text?: string | undefined;
  usage?: PlannerTokenUsage | undefined;
  isResult?: boolean | undefined;
}

interface CliPlannerSpec {
  buildArgs: (model: string | undefined, prompt: string, projectDir: string, mode: 'plan' | 'escalate') => string[];
  parseLine: (line: string) => ParsedLine;
  postProcess?: ((text: string, stderrOutput: string, usage: PlannerTokenUsage | null) => InvokeResult) | undefined;
  isAvailableOpts?: { timeout?: number | undefined } | undefined;
}

const SPECS: Record<CliPlannerKind, CliPlannerSpec> = {
  codex: {
    buildArgs: (model, prompt, projectDir) => {
      const args = ['exec', '--json', '--full-auto', '--cd', projectDir, prompt];
      if (model) args.unshift('--model', model);
      return args;
    },
    parseLine: parseJsonlLine,
  },
  opencode: {
    buildArgs: (model, prompt) => {
      const args = ['run', '--format', 'json', '--agent', 'plan', prompt];
      if (model) args.splice(1, 0, '--model', model);
      return args;
    },
    parseLine: parseOpencodeLine,
    isAvailableOpts: { timeout: 5000 },
  },
  aider: {
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
  const tool = CLI_TOOLS[kind];

  async function invoke(
    prompt: string,
    projectDir: string,
    onOutput: (text: string) => void,
    mode: 'plan' | 'escalate',
  ): Promise<InvokeResult> {
    let stderrOutput = '';
    const result = await spawnAndCollect({
      command: tool.command,
      args: spec.buildArgs(model, prompt, projectDir, mode),
      cwd: projectDir,
      notFoundMessage: tool.notFoundMessage,
      parseLine: spec.parseLine,
      onOutput,
      onStderr: spec.postProcess ? (chunk) => { stderrOutput += chunk; } : undefined,
    });

    if (spec.postProcess) return spec.postProcess(result.text, stderrOutput, result.usage);
    return result;
  }

  return createPlannerBase({
    invokePlan: (prompt, projectDir, onOutput) => invoke(prompt, projectDir, onOutput, 'plan'),
    invokeEscalate: (prompt, projectDir, onOutput) => invoke(prompt, projectDir, onOutput, 'escalate'),

    isAvailable: createIsAvailable(tool.command, spec.isAvailableOpts),
    getVersion: createGetVersion(tool.command),
  });
}
