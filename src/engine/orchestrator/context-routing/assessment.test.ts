import { describe, expect, it } from 'vitest';
import type { ResolvedImplementerProfile } from '../../../core/config/accessors/implementer-profiles.js';
import type { ProjectContext } from '../../../core/state/types.js';
import { DEFAULT_UNKNOWN_CONTEXT_LENGTH } from '../../../core/tokens/context-length.js';
import { makeTask } from '#testing/helpers/factories/task.js';
import { routeTaskToImplementerProfile } from './route.js';

const context: ProjectContext = {
  name: 'test-project',
  dir: '/repo',
};

function windowlessProfile(name: string): ResolvedImplementerProfile {
  return {
    name,
    costTier: 'local',
    config: {
      kind: 'api',
      provider: 'ollama',
      service: 'ollama',
      offering: 'local',
      apiBase: 'http://localhost:11434/v1',
      model: name,
    },
    capabilities: { writesFiles: 'extracted-code' },
    isDefault: false,
  };
}

describe('the shared default for an unknown context window', () => {
  it('lands a windowless profile on the single documented default and reports the conservative-fallback source', () => {
    const decision = routeTaskToImplementerProfile({
      task: makeTask(),
      context,
      profiles: [windowlessProfile('unknown-model')],
    });

    expect(decision.contextLength).toBe(DEFAULT_UNKNOWN_CONTEXT_LENGTH);
    expect(decision.reason).toContain('conservative context-length fallback');
  });

  it('fits a mid-size brief that overflowed the previous conservative fallback', () => {
    const decision = routeTaskToImplementerProfile({
      task: makeTask({
        action: 'modify',
        currentCode: Array.from({ length: 1800 }, (_, i) => `export const value${i} = ${i};`).join(
          '\n',
        ),
      }),
      context,
      profiles: [windowlessProfile('unknown-model')],
    });

    expect(decision.contextLength).toBe(DEFAULT_UNKNOWN_CONTEXT_LENGTH);
    expect(decision.estimatedTokens).toBeGreaterThan(7_123);
    expect(decision.fit).toBe('fits');
    expect(decision.selectedProfile).toBe('unknown-model');
  });
});
