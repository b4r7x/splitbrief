import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeConfig } from '#testing/helpers/factories/config.js';
import { withTempDir } from '#testing/helpers/temp-dir.js';
import { withLocalCatalog } from '#testing/helpers/faux/local-catalog.js';
import { makeOpenAiSseResponse } from '#testing/helpers/faux/openai-sse.js';
import { createApiImplementer } from '../../implementers/api.js';
import { describe, expect, it, vi } from 'vitest';
import type { ResolvedImplementerProfile } from '../../../core/config/accessors/implementer-profiles.js';
import type { ProjectContext } from '../../../core/state/types.js';
import { APPLICATION_DEFAULT_CONTEXT_TOKENS } from '../../providers/runtime-context.js';
import type { ModelCacheAccessor } from '../../providers/model/resolution.js';
import { makeTask } from '#testing/helpers/factories/task.js';
import { routeTaskToImplementerProfile } from './route.js';

const context: ProjectContext = {
  name: 'test-project',
  dir: '/repo',
};

function profile(name: string, contextLength?: number): ResolvedImplementerProfile {
  return {
    name,
    config: {
      kind: 'api',
      provider: 'ollama',
      service: 'ollama',
      offering: 'local',
      apiBase: 'http://localhost:11434/v1',
      model: name,
      ...(contextLength !== undefined ? { contextLength } : {}),
    },
    capabilities: { writesFiles: 'extracted-code' },
    isDefault: false,
  };
}

function customEndpointProfile(name: string, contextLength?: number): ResolvedImplementerProfile {
  return {
    name,
    config: {
      kind: 'api',
      provider: 'custom-endpoint',
      service: 'custom-endpoint',
      offering: 'payg',
      apiBase: 'https://api.example.com/v1',
      model: name,
      ...(contextLength !== undefined ? { contextLength } : {}),
    },
    capabilities: { writesFiles: 'extracted-code' },
    isDefault: false,
  };
}

function customApiProfile(
  name: string,
  contextLength?: number,
  apiKey?: string,
): ResolvedImplementerProfile {
  return {
    name,
    config: {
      kind: 'api',
      provider: 'custom-cloud',
      service: 'custom-cloud',
      offering: 'payg',
      apiBase: 'https://custom.example/v1',
      model: name,
      ...(apiKey !== undefined ? { apiKey } : {}),
      ...(contextLength !== undefined ? { contextLength } : {}),
    },
    capabilities: { writesFiles: 'extracted-code' },
    isDefault: false,
  };
}

function directProfile(name: string, contextLength?: number): ResolvedImplementerProfile {
  return {
    name,
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

function shellProfile(name: string, contextLength?: number): ResolvedImplementerProfile {
  return {
    name,
    config: {
      kind: 'shell',
      command: name,
      model: name,
      ...(contextLength !== undefined ? { contextLength } : {}),
    },
    capabilities: { writesFiles: 'extracted-code' },
    isDefault: false,
  };
}

describe('routeTaskToImplementerProfile', () => {
  it('applies both files through the API profile selected by routing', async () => {
    await withTempDir('routed-bundle', async (projectDir) => {
      const task = makeTask({ files: ['src/hello.ts', 'src/hello.test.ts'] });
      const api = profile('qwen2.5-coder:7b', 20_000);
      const decision = routeTaskToImplementerProfile({ task, context, profiles: [api] });
      expect(decision.selectedProfile).toBe(api.name);
      const config = makeConfig({ implementer: api.config });
      vi.stubGlobal(
        'fetch',
        vi.fn(
          withLocalCatalog(['qwen2.5-coder:7b'], () =>
            makeOpenAiSseResponse([
              {
                content: JSON.stringify({
                  version: 1,
                  files: [
                    {
                      path: 'src/hello.ts',
                      action: 'create',
                      content: 'export const hello = 1;\n',
                    },
                    {
                      path: 'src/hello.test.ts',
                      action: 'create',
                      content: 'export const test = 2;\n',
                    },
                  ],
                }),
              },
            ]),
          ),
        ),
      );
      try {
        const result = await createApiImplementer(config).implement({
          task,
          context: { ...context, dir: projectDir },
          config,
          projectDir,
          onOutput: () => {},
        });
        expect(result.success).toBe(true);
        expect(readFileSync(join(projectDir, 'src/hello.ts'), 'utf8')).toBe(
          'export const hello = 1;\n',
        );
        expect(readFileSync(join(projectDir, 'src/hello.test.ts'), 'utf8')).toBe(
          'export const test = 2;\n',
        );
      } finally {
        vi.unstubAllGlobals();
      }
    });
  });

  it('routes explicit multi-file bundles to API while rejecting legacy shell extraction', () => {
    const shell: ResolvedImplementerProfile = {
      name: 'shell',
      config: { kind: 'shell', command: 'worker', model: 'worker' },
      capabilities: { writesFiles: 'extracted-code' },
      isDefault: false,
    };
    const decision = routeTaskToImplementerProfile({
      task: makeTask({ files: ['src/hello.ts', 'src/hello.test.ts'] }),
      context,
      profiles: [shell, profile('local-api', 20_000)],
    });
    expect(decision.selectedProfile).toBe('local-api');
    expect(decision.requiredWriteMode).toBe('extracted-code');
    expect(decision.rejected[0]?.reason).toContain('single file');
    expect(
      routeTaskToImplementerProfile({
        task: makeTask(),
        context,
        profiles: [shell],
      }).selectedProfile,
    ).toBe('shell');
  });

  it('rejects API profiles whose bundle output reserve cannot fit', () => {
    const decision = routeTaskToImplementerProfile({
      task: makeTask({ files: ['src/hello.ts', 'src/hello.test.ts'] }),
      context,
      profiles: [profile('small', 4_000), profile('large', 20_000)],
    });
    expect(decision.selectedProfile).toBe('large');
    expect(decision.rejected[0]?.fit).toBe('overflow');
  });

  it('keeps full API bundle contents and refuses an overflowing sibling file', () => {
    const decision = routeTaskToImplementerProfile({
      task: makeTask({
        files: ['src/hello.ts', 'src/hello.test.ts'],
        currentCodeByFile: { 'src/hello.test.ts': 'export const x = 1;'.repeat(3000) },
      }),
      context,
      profiles: [profile('small', 6_000)],
    });
    expect(decision.selectedProfile).toBeUndefined();
    expect(decision.fit).toBe('overflow');
    expect(decision.estimatedTokens).toBe(decision.untruncatedEstimatedTokens);
    expect(decision.currentCodeTruncated).toBe(false);
    expect(decision.currentCodeContextMode).toBe('whole-file');
  });

  it('counts read-only context code in the fit estimate', () => {
    const task = makeTask({ contextFiles: ['src/types.ts'] });
    const withContext = routeTaskToImplementerProfile({
      task: { ...task, contextCodeByFile: { 'src/types.ts': 'export const x = 1;'.repeat(3000) } },
      context,
      profiles: [profile('small', 6_000)],
    });
    expect(
      routeTaskToImplementerProfile({ task, context, profiles: [profile('small', 6_000)] }).fit,
    ).toBe('fits');
    expect(withContext.fit).toBe('overflow');
    expect(withContext.currentCodeTruncated).toBe(false);
  });

  it("counts the run's plan context in the fit estimate", () => {
    const task = makeTask();
    const plan = {
      summary: 'Route every write through the registry.',
      decisions: ['Keep the registry as the one source of truth. '.repeat(400)],
      criteria: [],
      checks: [],
      validation: null,
    };
    expect(
      routeTaskToImplementerProfile({ task, context, profiles: [profile('small', 6_000)] }).fit,
    ).toBe('fits');
    expect(
      routeTaskToImplementerProfile({ task, context, profiles: [profile('small', 6_000)], plan })
        .fit,
    ).toBe('overflow');
  });

  it('chooses the smallest fitting profile within the same cost tier', () => {
    const task = makeTask();

    const decision = routeTaskToImplementerProfile({
      task,
      context,
      profiles: [profile('local-large', 20_000), profile('local-small', 10_000)],
    });

    expect(decision.selectedProfile).toBe('local-small');
    expect(decision.fit).toBe('fits');
    expect(decision.rejected.map((rejected) => rejected.profile)).toEqual(['local-large']);
  });

  it('selects the smallest capable context window among capable profiles', () => {
    const task = makeTask();

    const decision = routeTaskToImplementerProfile({
      task,
      context,
      profiles: [
        profile('frontier-big', 200_000),
        profile('standard-big', 80_000),
        profile('cheap-big', 40_000),
      ],
    });

    expect(decision.selectedProfile).toBe('cheap-big');
    expect(decision.rejected.map((rejected) => rejected.profile)).toEqual([
      'standard-big',
      'frontier-big',
    ]);
  });

  it('breaks a tie deterministically by profile name', () => {
    const task = makeTask();

    const first = routeTaskToImplementerProfile({
      task,
      context,
      profiles: [profile('zeta-worker', 10_000), profile('alpha-worker', 10_000)],
    });
    const second = routeTaskToImplementerProfile({
      task,
      context,
      profiles: [profile('alpha-worker', 10_000), profile('zeta-worker', 10_000)],
    });

    expect(first.selectedProfile).toBe('alpha-worker');
    expect(second).toEqual(first);
  });

  it('rejects overflow profiles and selects the next capable profile', () => {
    const task = makeTask();

    const decision = routeTaskToImplementerProfile({
      task,
      context,
      profiles: [profile('local-too-small', 100), profile('cheap-capable', 10_000)],
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
    const task = makeTask();

    const decision = routeTaskToImplementerProfile({
      task,
      context,
      profiles: [customEndpointProfile('cheap-cloud', 20_000), profile('standard-local', 20_000)],
    });

    expect(decision.selectedProfile).toBe('standard-local');
    expect(decision.rejected).toMatchObject([
      {
        profile: 'cheap-cloud',
        reason: expect.stringContaining('credentials are missing'),
      },
    ]);
  });

  it('skips custom API profiles without explicit apiKey and selects a usable fallback', () => {
    const task = makeTask();

    const decision = routeTaskToImplementerProfile({
      task,
      context,
      profiles: [customApiProfile('cheap-custom', 20_000), profile('standard-local', 20_000)],
    });

    expect(decision.selectedProfile).toBe('standard-local');
    expect(decision.rejected[0]).toMatchObject({
      profile: 'cheap-custom',
      reason: 'Custom provider custom-cloud credentials are missing; set profile apiKey',
    });
  });

  it('returns no selected profile when every otherwise capable profile is missing credentials', () => {
    const task = makeTask();

    const decision = routeTaskToImplementerProfile({
      task,
      context,
      profiles: [customEndpointProfile('cheap-cloud', 20_000)],
    });

    expect(decision.selectedProfile).toBeUndefined();
    expect(decision.reason).toContain('No credential-usable implementer profile');
    expect(decision.rejected[0]?.reason).toContain('Custom provider custom-endpoint');
  });

  it('rejects extracted-code profiles when task scope requires direct file writes', () => {
    const task = makeTask({
      file: 'src/main.ts',
      scope: { inBounds: ['src/main.ts', 'src/sidecar.ts'] },
    });

    const decision = routeTaskToImplementerProfile({
      task,
      context,
      profiles: [profile('local-api', 20_000), directProfile('agent-worker', 20_000)],
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

  it('requires direct writes for an additional bare root-level target', () => {
    const task = makeTask({
      file: 'src/main.ts',
      scope: { inBounds: ['src/main.ts', 'package.json'] },
    });

    const decision = routeTaskToImplementerProfile({
      task,
      context,
      profiles: [profile('local-api', 20_000), directProfile('agent-worker', 40_000)],
    });

    expect(decision.selectedProfile).toBe('agent-worker');
    expect(decision.requiredWriteMode).toBe('direct');
  });

  it('does not treat unquoted paths with spaces as direct-write scope', () => {
    const task = makeTask({
      file: 'src/main.ts',
      scope: { inBounds: ['src/main.ts', 'docs/User Guide.md'] },
    });

    const decision = routeTaskToImplementerProfile({
      task,
      context,
      profiles: [profile('local-api', 20_000), directProfile('agent-worker', 40_000)],
    });

    expect(decision.selectedProfile).toBe('local-api');
    expect(decision.requiredWriteMode).toBe('extracted-code');
  });

  it('requires direct writes for a second concrete path and for a glob scope pattern', () => {
    const secondPath = routeTaskToImplementerProfile({
      task: makeTask({ file: 'src/main.ts', scope: { inBounds: ['src/sidecar.ts'] } }),
      context,
      profiles: [profile('local-api', 20_000), directProfile('agent-worker', 20_000)],
    });
    expect(secondPath.requiredWriteMode).toBe('direct');
    expect(secondPath.selectedProfile).toBe('agent-worker');

    const globPath = routeTaskToImplementerProfile({
      task: makeTask({ file: 'src/main.ts', scope: { inBounds: ['src/features/**'] } }),
      context,
      profiles: [profile('local-api', 20_000), directProfile('agent-worker', 20_000)],
    });
    expect(globPath.requiredWriteMode).toBe('direct');
    expect(globPath.selectedProfile).toBe('agent-worker');
  });

  it('does not treat prose naming the task file itself as direct-write scope', () => {
    const task = makeTask({
      file: 'src/main.ts',
      scope: { inBounds: ['Modify only `src/main.ts`.'] },
    });

    const decision = routeTaskToImplementerProfile({
      task,
      context,
      profiles: [profile('local-api', 20_000), directProfile('agent-worker', 40_000)],
    });

    expect(decision.selectedProfile).toBe('local-api');
    expect(decision.requiredWriteMode).toBe('extracted-code');
  });

  it('does not treat prose scope entries as direct-write file scope', () => {
    const task = makeTask({
      file: 'src/main.ts',
      scope: { inBounds: ['email validation', 'only touch helpers.ts'] },
    });

    const decision = routeTaskToImplementerProfile({
      task,
      context,
      profiles: [profile('local-api', 20_000), directProfile('agent-worker', 40_000)],
    });

    expect(decision.selectedProfile).toBe('local-api');
    expect(decision.requiredWriteMode).toBe('extracted-code');
  });

  it('returns a clear no-capable-profile result when every profile overflows', () => {
    const task = makeTask();

    const decision = routeTaskToImplementerProfile({
      task,
      context,
      profiles: [profile('local-too-small', 100), profile('cheap-too-small', 150)],
    });

    expect(decision.selectedProfile).toBeUndefined();
    expect(decision.fit).toBe('overflow');
    expect(decision.reason).toContain('No capable implementer profile');
    expect(decision.rejected.map((rejected) => rejected.fit)).toEqual(['overflow', 'overflow']);
  });

  it('falls an unobserved api profile back to the application budget, not the routing fallback', () => {
    const task = makeTask();

    const decision = routeTaskToImplementerProfile({
      task,
      context,
      profiles: [profile('legacy-default')],
      conservativeContextLength: 10_000,
    });

    expect(decision.selectedProfile).toBe('legacy-default');
    expect(decision.contextLength).toBe(APPLICATION_DEFAULT_CONTEXT_TOKENS);
    expect(decision.reason).toContain('conservative context-length fallback');
  });

  it('reports a mid-size brief as overflow rather than admitting it on unobserved capacity', () => {
    const decision = routeTaskToImplementerProfile({
      task: makeTask({
        action: 'modify',
        currentCode: Array.from({ length: 1800 }, (_, i) => `export const value${i} = ${i};`).join(
          '\n',
        ),
      }),
      context,
      profiles: [profile('unknown-model')],
    });

    expect(decision.contextLength).toBe(APPLICATION_DEFAULT_CONTEXT_TOKENS);
    expect(decision.untruncatedEstimatedTokens).toBeGreaterThan(7_123);
    expect(decision.currentCodeTruncated).toBe(false);
    expect(decision.fit).toBe('overflow');
    expect(decision.selectedProfile).toBeUndefined();
  });

  it('does not treat catalog context as an observed active API context', () => {
    const task = makeTask();
    const modelCache: ModelCacheAccessor = {
      getModelsDevCatalog: () => null,
      getProviderModels: (providerId) =>
        providerId === 'lm-studio'
          ? [{ id: 'runtime-only', contextLength: 12_000, pricingInput: 1, pricingOutput: 2 }]
          : null,
    };
    const runtimeWorker: ResolvedImplementerProfile = {
      name: 'runtime-worker',
      config: {
        kind: 'api',
        provider: 'lm-studio',
        service: 'lm-studio',
        offering: 'local',
        apiBase: 'http://localhost:1234/v1',
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
    expect(withoutCache.contextLength).toBe(APPLICATION_DEFAULT_CONTEXT_TOKENS);

    const withCache = routeTaskToImplementerProfile({
      task,
      context,
      profiles: [runtimeWorker],
      modelCache,
    });
    expect(withCache.selectedProfile).toBe('runtime-worker');
    expect(withCache.contextLength).toBe(APPLICATION_DEFAULT_CONTEXT_TOKENS);
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
      profiles: [shellProfile('small-local', 2000), shellProfile('larger-cheap', 40_000)],
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

  it('sizes a direct writer on the prompt it is sent, which carries no current code', () => {
    const task = makeTask({
      action: 'modify',
      currentCode: Array.from({ length: 1200 }, (_, i) => `export const value${i} = ${i};`).join(
        '\n',
      ),
    });

    const decision = routeTaskToImplementerProfile({
      task,
      context,
      profiles: [directProfile('small-local', 2000)],
    });

    expect(decision.selectedProfile).toBe('small-local');
    expect(decision.fit).toBe('fits');
    expect(decision.currentCodeContextMode).toBe('none');
    expect(decision.currentCodeTruncated).toBe(false);
    expect(decision.estimatedTokens).toBe(decision.untruncatedEstimatedTokens);
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
      profiles: [shellProfile('function-context-worker', 6000)],
    });

    expect(decision.selectedProfile).toBe('function-context-worker');
    expect(decision.currentCodeContextMode).toBe('function-level');
    expect(decision.currentCodeTruncated).toBe(false);
    expect(decision.fit).toBe('tight');
    expect(decision.estimatedTokens).toBeLessThan(decision.untruncatedEstimatedTokens);
    expect(decision.reason).toContain('function-level context');
  });
});
