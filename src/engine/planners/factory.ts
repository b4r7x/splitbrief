import type { Config } from '../../types.js';
import type { Planner } from './types.js';

export async function createPlanner(config: Config): Promise<Planner> {
  const tool = config.planner.tool ?? 'claude-code';

  if (tool === 'claude-code' && config.planner.provider) {
    const { createApiPlanner } = await import('./api.js');
    return createApiPlanner(config);
  }

  switch (tool) {
    case 'claude-code': {
      const { createClaudeCodePlanner } = await import('./claude-code.js');
      return createClaudeCodePlanner(config.planner.model);
    }
    case 'codex':
    case 'opencode':
    case 'aider': {
      const { createCliPlanner } = await import('./cli.js');
      return createCliPlanner(tool, config.planner.model);
    }
    case 'agent-sdk': {
      const { createAgentSdkPlanner } = await import('./agent-sdk.js');
      return createAgentSdkPlanner(config.planner.model);
    }
    case 'shell': {
      const { createShellPlanner } = await import('./shell.js');
      return createShellPlanner(config);
    }
    case 'anthropic':
    case 'openrouter':
    case 'ollama':
    case 'lm-studio':
    case 'deepseek': {
      const { createApiPlanner } = await import('./api.js');
      return createApiPlanner({ ...config, planner: { ...config.planner, provider: tool } });
    }
    default:
      throw new Error(`Unknown planner tool: ${tool}. Supported: claude-code, codex, opencode, aider, agent-sdk, shell, anthropic, openrouter, ollama, lm-studio, deepseek`);
  }
}
