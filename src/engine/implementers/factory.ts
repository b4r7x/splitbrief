import type { Config } from '../../types.js';
import type { ImplementerBackend } from './types.js';

export async function createImplementer(config: Config): Promise<ImplementerBackend> {
  const type = config.implementer.type ?? 'api';
  switch (type) {
    case 'api': {
      const { createOpenAIImplementer } = await import('./openai.js');
      return createOpenAIImplementer(config);
    }
    case 'shell': {
      const { createShellImplementer } = await import('./shell.js');
      return createShellImplementer(config);
    }
    case 'agent': {
      const { createAgentImplementer } = await import('./agent.js');
      return createAgentImplementer(config);
    }
    default:
      throw new Error(`Unknown implementer type: ${type}. Supported: api, shell, agent`);
  }
}
