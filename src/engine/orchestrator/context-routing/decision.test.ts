import { describe, expect, it } from 'vitest';
import { makeTask } from '#testing/helpers/factories/task.js';
import { compareProfileRouteRank, requiredWriteModeForTask } from './decision.js';
import type { ProfileFit } from './types.js';

function profileFit(name: string, contextLength: number): ProfileFit {
  return {
    profile: {
      name,
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
    },
    fit: 'fits',
    estimatedTokens: 1_000,
    untruncatedEstimatedTokens: 1_000,
    contextLength,
    currentCodeTruncated: false,
    currentCodeContextMode: 'none',
    usedConservativeContextLength: false,
    requiredWriteMode: 'extracted-code',
  };
}

describe('compareProfileRouteRank', () => {
  it('ranks by context length, smallest first', () => {
    expect(
      compareProfileRouteRank(profileFit('small', 1_000), profileFit('large', 10_000)),
    ).toBeLessThan(0);
    expect(
      compareProfileRouteRank(profileFit('large', 10_000), profileFit('small', 1_000)),
    ).toBeGreaterThan(0);
  });

  it('breaks a context-length tie by name', () => {
    expect(
      compareProfileRouteRank(profileFit('alpha', 8_000), profileFit('beta', 8_000)),
    ).toBeLessThan(0);
  });

  it('stays a total order over a mixed set', () => {
    const profiles = [
      profileFit('zeta', 8_000),
      profileFit('alpha', 8_000),
      profileFit('tiny', 1_000),
      profileFit('huge', 200_000),
    ];

    expect(profiles.toSorted(compareProfileRouteRank).map((fit) => fit.profile.name)).toEqual([
      'tiny',
      'alpha',
      'zeta',
      'huge',
    ]);
  });
});

describe('requiredWriteModeForTask', () => {
  it.each([
    ['src/hello.ts', 'src/**'],
    ['src/hello.ts', 'src/'],
    ['src/hello.ts', '../outside.ts'],
    ['src/hello.ts', 'src/hello.ts'],
    ['src/hello.ts', 'src/hello.ts/nested.ts'],
    ['src/file0.ts', ...Array.from({ length: 32 }, (_, i) => `src/file${i + 1}.ts`)],
  ])('requires direct writes for unsupported targets %j', (anchor, ...rest) => {
    expect(requiredWriteModeForTask(makeTask({ suggestedFiles: [anchor, ...rest] }))).toBe(
      'direct',
    );
  });

  it('allows explicit multi-file bundles', () => {
    expect(
      requiredWriteModeForTask(makeTask({ suggestedFiles: ['src/hello.ts', 'src/hello.test.ts'] })),
    ).toBe('extracted-code');
    expect(requiredWriteModeForTask(makeTask())).toBe('extracted-code');
  });
});
