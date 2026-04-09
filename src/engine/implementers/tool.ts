import type { Config } from '../../types.js';
import type { Implementer } from './types.js';
import type { InvokeOpts } from './base.js';
import { createImplementerBase, createChangeDetector, DEFAULT_TIMEOUT, assertSpawnSuccess } from './base.js';
import { isENOENT } from '../../utils/process.js';
import { spawnWithTimeout } from '../../utils/process.js';
import type { SpawnResult } from '../../utils/process.js';
import { CLI_TOOL_NAMES, type ToolName } from '../../types.js';
import { CLI_TOOLS } from '../cli-tools.js';

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
    command: CLI_TOOLS.codex.command,
    buildArgs: (prompt, model) => {
      const args: string[] = ['--quiet', '--full-auto', '-p', prompt];
      if (model) args.push('--model', model);
      return args;
    },
    notFoundMessage: CLI_TOOLS.codex.notFoundMessage,
  },
  opencode: {
    command: CLI_TOOLS.opencode.command,
    buildArgs: (prompt, model) => {
      const args = [prompt];
      if (model) args.push('--model', model);
      return args;
    },
    notFoundMessage: CLI_TOOLS.opencode.notFoundMessage,
  },
  aider: {
    command: CLI_TOOLS.aider.command,
    buildArgs: (prompt, model) => {
      const args = ['--message', prompt, '--yes-always'];
      if (model) args.push('--model', model);
      return args;
    },
    notFoundMessage: CLI_TOOLS.aider.notFoundMessage,
  },
};

export function createToolImplementer(toolName: string, config: Config): Implementer {
  const toolConfig = TOOL_CONFIGS[toolName as ToolName];
  if (!toolConfig) {
    throw new Error(`Unknown tool implementer: ${toolName}. Supported: ${CLI_TOOL_NAMES.join(', ')}`);
  }

  const timeout = config.implementer.timeout ?? DEFAULT_TIMEOUT;

  return createImplementerBase({
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

      assertSpawnSuccess(result, {
        label: `Tool implementer (${toolName})`,
        timeoutMs: timeout,
        notFoundMessage: toolConfig.notFoundMessage,
      });

      return { text: result.output };
    },

    detectChanges: createChangeDetector(`Tool implementer (${toolName})`),

    shouldThrow(err: unknown) {
      return err instanceof Error && (
        err.message.includes('not found') ||
        err.message.includes('timed out')
      );
    },
  });
}
