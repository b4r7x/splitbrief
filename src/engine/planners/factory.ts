import type { Config } from '../../types.js';
import type { PlannerBackend } from './types.js';

export async function createPlanner(config: Config): Promise<PlannerBackend> {
  if (config.planner.provider) {
    const { createApiPlanner } = await import('./api.js');
    return createApiPlanner(config);
  }

  const tool = config.planner.tool ?? 'claude-code';

  switch (tool) {
    case 'claude-code': {
      const { createClaudeCodePlanner } = await import('./claude-code.js');
      return createClaudeCodePlanner();
    }
    case 'codex': {
      const { createCodexPlanner } = await import('./codex.js');
      return createCodexPlanner();
    }
    case 'opencode': {
      const { createOpenCodePlanner } = await import('./opencode.js');
      return createOpenCodePlanner();
    }
    case 'aider': {
      const { createAiderPlanner } = await import('./aider.js');
      return createAiderPlanner(config);
    }
    case 'agent-sdk': {
      const { createAgentSdkPlanner } = await import('./agent-sdk.js');
      return createAgentSdkPlanner(config);
    }
    case 'shell': {
      const { createShellPlanner } = await import('./shell.js');
      return createShellPlanner(config);
    }
    default:
      throw new Error(`Unknown planner tool: ${tool}. Supported: claude-code, codex, opencode, aider, agent-sdk, shell`);
  }
}
