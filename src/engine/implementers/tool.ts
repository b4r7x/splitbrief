import type { Config } from '../../types.js';
import type { Implementer } from './types.js';
import type { InvokeOpts } from './base.js';
import { createImplementerBase, createChangeDetector, DEFAULT_TIMEOUT } from './base.js';
import { isENOENT, runCommand } from '../../utils/process.js';
import { spawnWithTimeout, createProcessError } from '../../utils/process.js';
import type { SpawnResult } from '../../utils/process.js';
import { CLI_TOOL_NAMES, type ToolName } from '../../types.js';

interface ToolConfig {
  command: string;
  buildArgs: (prompt: string, model?: string) => string[];
  notFoundMessage: string;
}

const TOOL_CONFIGS: Record<ToolName, ToolConfig> = {
  'claude-code': {
    command: 'claude',
    buildArgs: (prompt, model) => {
      const args = ['--print', '--output-format', 'text', '-p', prompt];
      if (model) args.push('--model', model);
      return args;
    },
    notFoundMessage: 'Claude Code CLI not found. Install it from https://claude.ai/code',
  },
  codex: {
    command: 'codex',
    buildArgs: (prompt, model) => {
      const args: string[] = ['--quiet', '--full-auto', '-p', prompt];
      if (model) args.push('--model', model);
      return args;
    },
    notFoundMessage: 'Codex CLI not found. Install it with: npm install -g @openai/codex',
  },
  opencode: {
    command: 'opencode',
    buildArgs: (prompt, model) => {
      const args = [prompt];
      if (model) args.push('--model', model);
      return args;
    },
    notFoundMessage: 'OpenCode CLI not found. Install it from https://opencode.ai',
  },
  aider: {
    command: 'aider',
    buildArgs: (prompt, model) => {
      const args = ['--message', prompt, '--yes-always'];
      if (model) args.push('--model', model);
      return args;
    },
    notFoundMessage: 'Aider not found. Install it from https://aider.chat',
  },
};

export function createToolImplementer(toolName: string, config: Config): Implementer {
  const toolConfig = TOOL_CONFIGS[toolName as ToolName];
  if (!toolConfig) {
    throw new Error(`Unknown tool implementer: ${toolName}. Supported: ${CLI_TOOL_NAMES.join(', ')}`);
  }

  const timeout = config.implementer.timeout ?? DEFAULT_TIMEOUT;

  return createImplementerBase({
    name: `tool:${toolName}`,
    pricingKey: toolName,
    extractsCode: false,

    async invoke(opts: InvokeOpts) {
      const { prompt, projectDir, onProgress } = opts;
      const effectiveModel = opts.config.implementer.model || opts.config.planner.model;
      const args = toolConfig.buildArgs(prompt, effectiveModel);

      let result: SpawnResult;
      try {
        result = await spawnWithTimeout({ command: toolConfig.command, args, cwd: projectDir, timeout, onProgress });
      } catch (err) {
        if (isENOENT(err)) throw new Error(toolConfig.notFoundMessage);
        throw err;
      }

      if (result.code === 127) {
        throw new Error(toolConfig.notFoundMessage);
      }
      if (result.timedOut) {
        throw createProcessError(`Tool implementer (${toolName}) timed out after ${Math.round(timeout / 1000)}s`, result.output);
      }
      if (result.code !== 0) {
        const detail = result.stderr.trim();
        throw createProcessError(
          `Tool implementer (${toolName}) exited with code ${result.code}${detail ? `: ${detail}` : ''}`,
          result.output,
        );
      }

      return { text: result.output };
    },

    detectChanges: createChangeDetector(`Tool implementer (${toolName})`),

    shouldThrow(err: unknown) {
      return err instanceof Error && (
        err.message.includes('not found') ||
        err.message.includes('timed out')
      );
    },

    async isAvailable() {
      try {
        const { code } = await runCommand(toolConfig.command, ['--version']);
        return code === 0;
      } catch {
        return false;
      }
    },
  });
}
