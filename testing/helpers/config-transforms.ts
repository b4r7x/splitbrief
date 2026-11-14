import type { Config } from '../../src/core/schemas/config.js';
import { makeConfig } from './factories/config.js';

export function makeBaseConfig(): Config {
  return makeConfig({
    planner: {
      kind: 'shell',
      command: 'old-command',
    },
    implementer: {
      service: 'ollama',
      offering: 'local',
      model: 'llama3',
      contextLength: 8192,
      temperature: 0.3,
    },
  });
}
