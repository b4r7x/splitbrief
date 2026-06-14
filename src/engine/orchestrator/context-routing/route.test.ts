import { describe, expect, it } from 'vitest';
import type { ResolvedImplementerProfile } from '../../../core/config/accessors/implementer-profiles.js';
import type { ImplementerCostTier } from '../../../core/schemas/implementer-config.js';
import type { ProjectContext } from '../../../core/state/types.js';
import type { ModelCacheAccessor } from '../../providers/model/resolution.js';
import { makeTask } from '#testing/helpers/factories/task.js';
import { routeTaskToImplementerProfile } from './route.js';

const context: ProjectContext = {
  name: 'test-project',
  dir: '/repo',
};

function profile(
  name: string,
  costTier: ImplementerCostTier,
  contextLength?: number,
): ResolvedImplementerProfile {
  return {
    name,
    costTier,
    config: {
      kind: 'api',
      provider: 'ollama',
      apiBase: 'http://localhost:11434/v1',
      model: name,
      ...(contextLength !== undefined ? { contextLength } : {}),
    },
    capabilities: { writesFiles: 'extracted-code' },
    isDefault: false,
  };
}

function openRouterProfile(
  name: string,
  costTier: ImplementerCostTier,
  contextLength?: number,
): ResolvedImplementerProfile {
  return {
    name,
    costTier,
    config: {
      kind: 'api',
      provider: 'openrouter',
      apiBase: 'https://openrouter.ai/api/v1',
      model: name,
      ...(contextLength !== undefined ? { contextLength } : {}),
    },
    capabilities: { writesFiles: 'extracted-code' },
    isDefault: false,
  };
}

function customApiProfile(
  name: string,
  costTier: ImplementerCostTier,
  contextLength?: number,
  apiKey?: string,
): ResolvedImplementerProfile {
  return {
    name,
    costTier,
    config: {
      kind: 'api',
      provider: 'custom-cloud',
      apiBase: 'https://custom.example/v1',
      model: name,
      ...(apiKey !== undefined ? { apiKey } : {}),
      ...(contextLength !== undefined ? { contextLength } : {}),
    },
    capabilities: { writesFiles: 'extracted-code' },
    isDefault: false,
  };
}

function directProfile(
  name: string,
  costTier: ImplementerCostTier,
  contextLength?: number,
): ResolvedImplementerProfile {
  return {
    name,
    costTier,
    config: {
      kind: 'agent',
      command: name,
      model: name,
      ...(contextLength !== undefined ? { contextLength } : {}),
    },
    capabilities: { writesFiles: 'direct' },
    isDefault: false,
  };
}

describe('routeTaskToImplementerProfile', () => {
  it('chooses the smallest fitting profile within the same cost tier', () => {
    const task = makeTask();

    const decision = routeTaskToImplementerProfile({
      task,
      context,
      profiles: [profile('local-large', 'local', 20_000), profile('local-small', 'local', 10_000)],
    });

    expect(decision.selectedProfile).toBe('local-small');
    expect(decision.selectedCostTier).toBe('local');
    expect(decision.costPosture).toContain('Selected local cost tier');
    expect(decision.fit).toBe('fits');
    expect(decision.rejected.map((rejected) => rejected.profile)).toEqual(['local-large']);
  });

  it('sorts local and cheap tiers before more expensive capable profiles', () => {
    const task = makeTask();

    const decision = routeTaskToImplementerProfile({
      task,
      context,
      profiles: [
        profile('frontier-big', 'frontier', 200_000),
        profile('standard-big', 'standard', 80_000),
        profile('cheap-big', 'cheap', 40_000),
      ],
    });

    expect(decision.selectedProfile).toBe('cheap-big');
    expect(decision.rejected.map((rejected) => rejected.profile)).toEqual([
      'standard-big',
      'frontier-big',
    ]);
  });

  it('handles unknown cost tiers deterministically by profile name', () => {
    const task = makeTask();

    const first = routeTaskToImplementerProfile({
      task,
      context,
      profiles: [
        profile('zeta-worker', 'unknown', 10_000),
        profile('alpha-worker', 'unknown', 10_000),
      ],
    });
    const second = routeTaskToImplementerProfile({
      task,
      context,
      profiles: [
        profile('alpha-worker', 'unknown', 10_000),
        profile('zeta-worker', 'unknown', 10_000),
      ],
    });

    expect(first.selectedProfile).toBe('alpha-worker');
    expect(second).toEqual(first);
  });

  it('rejects overflow profiles and selects the next capable profile', () => {
    const task = makeTask();

    const decision = routeTaskToImplementerProfile({
      task,
      context,
      profiles: [
        profile('local-too-small', 'local', 100),
        profile('cheap-capable', 'cheap', 10_000),
      ],
    });

    expect(decision.selectedProfile).toBe('cheap-capable');
    expect(decision.rejected).toMatchObject([
      {
        profile: 'local-too-small',
        fit: 'overflow',
      },
    ]);
  });

  it('skips credential-missing profiles and selects a usable fallback', () => {
    const originalKey = process.env['OPENROUTER_API_KEY'];
    delete process.env['OPENROUTER_API_KEY'];
    try {
      const task = makeTask();

      const decision = routeTaskToImplementerProfile({
        task,
        context,
        profiles: [
          openRouterProfile('cheap-cloud', 'cheap', 20_000),
          profile('standard-local', 'standard', 20_000),
        ],
      });

      expect(decision.selectedProfile).toBe('standard-local');
      expect(decision.rejected).toMatchObject([
        {
          profile: 'cheap-cloud',
          reason: expect.stringContaining('credentials are missing'),
        },
      ]);
    } finally {
      if (originalKey === undefined) delete process.env['OPENROUTER_API_KEY'];
      else process.env['OPENROUTER_API_KEY'] = originalKey;
    }
  });

  it('skips custom API profiles without explicit apiKey and selects a usable fallback', () => {
    const task = makeTask();

    const decision = routeTaskToImplementerProfile({
      task,
      context,
      profiles: [
        customApiProfile('cheap-custom', 'cheap', 20_000),
        profile('standard-local', 'standard', 20_000),
      ],
    });

    expect(decision.selectedProfile).toBe('standard-local');
    expect(decision.rejected[0]).toMatchObject({
      profile: 'cheap-custom',
      reason: 'Custom provider custom-cloud credentials are missing; set profile apiKey',
    });
  });

  it('returns no selected profile when every otherwise capable profile is missing credentials', () => {
    const originalKey = process.env['OPENROUTER_API_KEY'];
    delete process.env['OPENROUTER_API_KEY'];
    try {
      const task = makeTask();

      const decision = routeTaskToImplementerProfile({
        task,
        context,
        profiles: [openRouterProfile('cheap-cloud', 'cheap', 20_000)],
      });

      expect(decision.selectedProfile).toBeUndefined();
      expect(decision.reason).toContain('No credential-usable implementer profile');
      expect(decision.rejected[0]?.reason).toContain('OPENROUTER_API_KEY');
    } finally {
      if (originalKey === undefined) delete process.env['OPENROUTER_API_KEY'];
      else process.env['OPENROUTER_API_KEY'] = originalKey;
    }
  });

  it('rejects extracted-code profiles when task scope requires direct file writes', () => {
    const task = makeTask({
      file: 'src/main.ts',
      scope: { inBounds: ['src/main.ts', 'src/sidecar.ts'] },
    });

    const decision = routeTaskToImplementerProfile({
      task,
      context,
      profiles: [
        profile('local-api', 'local', 20_000),
        directProfile('agent-worker', 'standard', 20_000),
      ],
    });

    expect(decision.selectedProfile).toBe('agent-worker');
    expect(decision.requiredWriteMode).toBe('direct');
    expect(decision.selectedWriteMode).toBe('direct');
    expect(decision.rejected).toMatchObject([
      {
        profile: 'local-api',
        profileWriteMode: 'extracted-code',
        requiredWriteMode: 'direct',
      },
    ]);
    expect(decision.rejected[0]?.reason).toContain('requires direct file writes');
  });

  it('treats root-level additional files as direct-write scope', () => {
    const task = makeTask({
      file: 'src/main.ts',
      scope: { inBounds: ['src/main.ts', 'package.json'] },
    });

    const decision = routeTaskToImplementerProfile({
      task,
      context,
      profiles: [
        profile('local-api', 'local', 20_000),
        directProfile('agent-worker', 'standard', 20_000),
      ],
    });

    expect(decision.selectedProfile).toBe('agent-worker');
    expect(decision.requiredWriteMode).toBe('direct');
    expect(decision.rejected[0]?.reason).toContain('requires direct file writes');
  });

  it('treats nested paths with spaces as direct-write scope', () => {
    const task = makeTask({
      file: 'src/main.ts',
      scope: { inBounds: ['src/main.ts', 'docs/User Guide.md'] },
    });

    const decision = routeTaskToImplementerProfile({
      task,
      context,
      profiles: [
        profile('local-api', 'local', 20_000),
        directProfile('agent-worker', 'standard', 20_000),
      ],
    });

    expect(decision.selectedProfile).toBe('agent-worker');
    expect(decision.requiredWriteMode).toBe('direct');
  });

  it('does not treat prose scope entries as direct-write file scope', () => {
    const task = makeTask({
      file: 'src/main.ts',
      scope: { inBounds: ['email validation', 'only touch helpers.ts'] },
    });

    const decision = routeTaskToImplementerProfile({
      task,
      context,
      profiles: [
        profile('local-api', 'local', 20_000),
        directProfile('agent-worker', 'standard', 20_000),
      ],
    });

    expect(decision.selectedProfile).toBe('local-api');
    expect(decision.requiredWriteMode).toBe('extracted-code');
  });

  it('returns a clear no-capable-profile result when every profile overflows', () => {
    const task = makeTask();

    const decision = routeTaskToImplementerProfile({
      task,
      context,
      profiles: [
        profile('local-too-small', 'local', 100),
        profile('cheap-too-small', 'cheap', 150),
      ],
    });

    expect(decision.selectedProfile).toBeUndefined();
    expect(decision.fit).toBe('overflow');
    expect(decision.reason).toContain('No capable implementer profile');
    expect(decision.rejected.map((rejected) => rejected.fit)).toEqual(['overflow', 'overflow']);
  });

  it('uses a conservative fallback when a profile has no declared context length', () => {
    const task = makeTask();

    const decision = routeTaskToImplementerProfile({
      task,
      context,
      profiles: [profile('legacy-default', 'unknown')],
      conservativeContextLength: 10_000,
    });

    expect(decision.selectedProfile).toBe('legacy-default');
    expect(decision.contextLength).toBe(10_000);
    expect(decision.reason).toContain('conservative context-length fallback');
  });

  it('assesses a cache-resolvable model at its catalog context length, matching the estimate path', () => {
    const task = makeTask();
    const contextCache: ModelCacheAccessor = {
      getModelsDevCatalog: () => null,
      getProviderModels: (providerId) =>
        providerId === 'deepseek'
          ? [{ id: 'runtime-only', contextLength: 12_000, pricingInput: 1, pricingOutput: 2 }]
          : null,
    };
    const runtimeWorker: ResolvedImplementerProfile = {
      name: 'runtime-worker',
      costTier: 'cheap',
      config: {
        kind: 'api',
        provider: 'deepseek',
        apiBase: 'https://api.deepseek.com/v1',
        apiKey: 'test-key',
        model: 'runtime-only',
      },
      capabilities: { writesFiles: 'extracted-code' },
      isDefault: false,
    };

    const withoutCache = routeTaskToImplementerProfile({
      task,
      context,
      profiles: [runtimeWorker],
    });
    expect(withoutCache.contextLength).toBe(8192);

    const withCache = routeTaskToImplementerProfile({
      task,
      context,
      profiles: [runtimeWorker],
      contextCache,
    });
    expect(withCache.selectedProfile).toBe('runtime-worker');
    expect(withCache.contextLength).toBe(12_000);
  });

  it('rejects profiles that only fit after unsafe currentCode truncation', () => {
    const task = makeTask({
      action: 'modify',
      currentCode: Array.from({ length: 1200 }, (_, i) => `export const value${i} = ${i};`).join(
        '\n',
      ),
    });

    const decision = routeTaskToImplementerProfile({
      task,
      context,
      profiles: [profile('small-local', 'local', 2000), profile('larger-cheap', 'cheap', 40_000)],
    });

    expect(decision.selectedProfile).toBe('larger-cheap');
    expect(decision.fit).toBe('fits');
    expect(decision.currentCodeTruncated).toBe(false);
    expect(decision.rejected).toMatchObject([
      {
        profile: 'small-local',
        fit: 'overflow',
        currentCodeTruncated: true,
      },
    ]);
    expect(decision.rejected[0]?.untruncatedEstimatedTokens).toBeGreaterThan(
      decision.rejected[0]?.estimatedTokens ?? 0,
    );
    expect(decision.rejected[0]?.reason).toContain('current code truncated');
  });

  it('marks function-level currentCode fallback in routing metadata', () => {
    const task = makeTask({
      action: 'modify',
      signature: 'export function target(input: string): string',
      currentCode: [
        'import { normalize } from "./normalize.js";',
        '',
        'export function target(input: string): string {',
        '  return normalize(input);',
        '}',
        '',
        ...Array.from({ length: 900 }, (_, i) => `export const value${i} = ${i};`),
      ].join('\n'),
    });

    const decision = routeTaskToImplementerProfile({
      task,
      context,
      profiles: [profile('function-context-worker', 'local', 6000)],
    });

    expect(decision.selectedProfile).toBe('function-context-worker');
    expect(decision.currentCodeContextMode).toBe('function-level');
    expect(decision.currentCodeTruncated).toBe(false);
    expect(decision.fit).toBe('tight');
    expect(decision.estimatedTokens).toBeLessThan(decision.untruncatedEstimatedTokens);
    expect(decision.reason).toContain('function-level context');
  });
});
