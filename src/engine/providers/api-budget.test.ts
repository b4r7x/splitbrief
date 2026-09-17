import { describe, expect, it } from 'vitest';
import { estimateBundleOutputReserve, measureApiBudget } from './api-budget.js';
import type { ApiBudgetBuildTarget, ApiRuntimeContext } from './runtime-context.js';

function context(overrides: Partial<ApiRuntimeContext> = {}): ApiRuntimeContext {
  return {
    contextKey: 'lmstudio:http://127.0.0.1:1234',
    selectionId: 'test-model',
    observedAt: 1_700_000_000_000,
    applicationContextTokens: 8_192,
    budgetSource: 'application-default',
    loadState: 'unknown',
    ...overrides,
  };
}

function userMessage(characters: number) {
  return [{ role: 'user', content: 'x'.repeat(characters) }] as const;
}

describe('measureApiBudget', () => {
  it('admits a small packet against the unknown-capacity assumption', () => {
    const measurement = measureApiBudget({
      context: context(),
      messages: [{ role: 'user', content: 'hello' }],
      role: 'plan',
    });

    expect(measurement).toEqual({
      kind: 'fits',
      inputEstimate: 26,
      estimationMargin: 4,
      outputReserve: 2_048,
      maxTokens: 8_162,
      applicationContextTokens: 8_192,
      outputCap: 8_192,
    });
  });

  it('admits a packet that fills the context exactly, with no negative maxTokens', () => {
    const measurement = measureApiBudget({
      context: context(),
      messages: userMessage(21_272),
      role: 'plan',
    });

    expect(measurement).toEqual({
      kind: 'fits',
      inputEstimate: 5_342,
      estimationMargin: 802,
      outputReserve: 2_048,
      maxTokens: 2_048,
      applicationContextTokens: 8_192,
      outputCap: 8_192,
    });
  });

  it('refuses one token over input plus margin plus reserve', () => {
    const measurement = measureApiBudget({
      context: context(),
      messages: userMessage(21_276),
      role: 'plan',
    });

    expect(measurement).toEqual({
      kind: 'insufficient',
      reason: 'input',
      inputEstimate: 5_343,
      estimationMargin: 802,
      requiredOutputTokens: 2_048,
      applicationContextTokens: 8_192,
      outputCap: 8_192,
      minimumRequiredTokens: 8_193,
    });
  });

  it('refuses a reserve larger than a known output cap instead of shrinking it', () => {
    const measurement = measureApiBudget({
      context: context({ maximumOutputTokens: 1_024, applicationContextTokens: 131_072 }),
      messages: [{ role: 'user', content: 'hello' }],
      role: 'review',
    });

    expect(measurement).toEqual({
      kind: 'insufficient',
      reason: 'output',
      inputEstimate: 26,
      estimationMargin: 4,
      requiredOutputTokens: 2_048,
      applicationContextTokens: 131_072,
      outputCap: 1_024,
      minimumRequiredTokens: 2_078,
    });
  });

  it('caps output at the observed output ceiling, never at the whole context', () => {
    const measurement = measureApiBudget({
      context: context({ applicationContextTokens: 131_072, maximumOutputTokens: 4_096 }),
      messages: [{ role: 'user', content: 'hello' }],
      role: 'plan',
    });

    expect(measurement).toEqual(
      expect.objectContaining({ kind: 'fits', maxTokens: 4_096, outputCap: 4_096 }),
    );
  });

  it('counts every message and the request envelope', () => {
    const one = measureApiBudget({
      context: context(),
      messages: [{ role: 'user', content: 'abcd' }],
      role: 'plan',
    });
    const three = measureApiBudget({
      context: context(),
      messages: [
        { role: 'system', content: 'abcd' },
        { role: 'user', content: 'abcd' },
        { role: 'assistant', content: 'abcd' },
      ],
      role: 'plan',
    });

    expect(one).toEqual(expect.objectContaining({ inputEstimate: 1 + 8 + 16 }));
    expect(three).toEqual(expect.objectContaining({ inputEstimate: 3 + 24 + 16 }));
  });

  it('reserves the base allowance for PLAN and REVIEW regardless of build targets', () => {
    const targets: ApiBudgetBuildTarget[] = [
      { path: 'src/a.ts', action: 'create' },
      { path: 'src/b.ts', action: 'create' },
    ];

    for (const role of ['plan', 'review'] as const) {
      const measurement = measureApiBudget({
        context: context(),
        messages: [{ role: 'user', content: 'hello' }],
        role,
        buildTargets: targets,
      });
      expect(measurement).toEqual(expect.objectContaining({ outputReserve: 2_048 }));
    }
  });

  it('reserves the bundle allowance for BUILD', () => {
    const measurement = measureApiBudget({
      context: context({ applicationContextTokens: 131_072 }),
      messages: [{ role: 'user', content: 'hello' }],
      role: 'build',
      buildTargets: [
        { path: 'src/a.ts', action: 'create' },
        { path: 'src/b.ts', action: 'create' },
      ],
    });

    expect(measurement).toEqual(expect.objectContaining({ kind: 'fits', outputReserve: 4_104 }));
  });

  it('falls back to the base reserve when BUILD declares no targets', () => {
    const measurement = measureApiBudget({
      context: context(),
      messages: [{ role: 'user', content: 'hello' }],
      role: 'build',
    });

    expect(measurement).toEqual(expect.objectContaining({ outputReserve: 2_048 }));
  });
});

describe('estimateBundleOutputReserve', () => {
  it('gives two creates 4096 tokens plus the bundle envelope and its growth', () => {
    const reserve = estimateBundleOutputReserve(
      [
        { path: 'src/a.ts', action: 'create' },
        { path: 'src/b.ts', action: 'create' },
      ],
      'test-model',
    );

    // {"version":1,"files":[]} is 24 characters: ceil(24 / 4) = 6, ceil(6 * 1.25) = 8.
    expect(reserve).toBe(2 * 2_048 + 8);
  });

  it('counts the escaped JSON of a modify baseline, not its raw text', () => {
    const plain = estimateBundleOutputReserve(
      [{ path: 'src/a.ts', action: 'modify', content: 'a'.repeat(16_000) }],
      'test-model',
    );
    const escaped = estimateBundleOutputReserve(
      [{ path: 'src/a.ts', action: 'modify', content: '\\'.repeat(16_000) }],
      'test-model',
    );

    // 74 characters of path/action/content syntax around the escaped content.
    expect(plain).toBe(Math.ceil(Math.ceil((16_000 + 74) / 4) * 1.25));
    expect(plain).toBe(5_024);
    expect(escaped).toBe(10_024);
    expect(escaped).toBeGreaterThan(plain);
  });

  it('never drops below the base reserve', () => {
    expect(estimateBundleOutputReserve([], 'test-model')).toBe(2_048);
    expect(
      estimateBundleOutputReserve(
        [{ path: 'src/a.ts', action: 'modify', content: 'tiny' }],
        'test-model',
      ),
    ).toBe(2_048);
  });

  it('counts every declared target even when one of them is a create', () => {
    const reserve = estimateBundleOutputReserve(
      [
        { path: 'src/a.ts', action: 'modify', content: 'a'.repeat(16_000) },
        { path: 'src/b.ts', action: 'create' },
      ],
      'test-model',
    );

    expect(reserve).toBe(5_024 + 2_048);
  });
});
