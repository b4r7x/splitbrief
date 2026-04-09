import type { Config } from '../../types.js';
import type { Implementer } from './types.js';
import { createBackend } from '../../utils/backend-factory.js';

export async function createImplementer(config: Config): Promise<Implementer> {
  const type = config.implementer.kind ?? 'api';

  const registry: Record<string, () => Promise<Implementer>> = {
    api: async () => (await import('./api.js')).createApiImplementer(config),
    shell: async () => (await import('./shell.js')).createShellImplementer(config),
    agent: async () => (await import('./agent.js')).createAgentImplementer(config),
    'agent-sdk': async () => (await import('./agent-sdk.js')).createAgentSdkImplementer(config),
    'claude-code': async () => (await import('./tool.js')).createToolImplementer('claude-code', config),
    codex: async () => (await import('./tool.js')).createToolImplementer('codex', config),
    opencode: async () => (await import('./tool.js')).createToolImplementer('opencode', config),
    aider: async () => (await import('./tool.js')).createToolImplementer('aider', config),
  };

  return createBackend(type, registry, 'implementer type');
}
