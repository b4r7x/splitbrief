import { describe, expect, it } from 'vitest';
import { cloneDetectedModel } from '../clone-model.js';
import { DetectedModelSchema } from './model.js';

describe('detection schemas', () => {
  it('accepts source-bearing pricing dates without requiring pricing on every model', () => {
    expect(
      DetectedModelSchema.safeParse({
        id: 'priced-model',
        pricingInput: 1,
        pricingOutput: 2,
        pricingProvenance: {
          asOf: '2026-07-31',
          source: 'test fixture pricing record',
        },
      }).success,
    ).toBe(true);
    expect(DetectedModelSchema.safeParse({ id: 'unpriced-model' }).success).toBe(true);
  });

  it.each([
    { asOf: '2026-7-31', source: 'test fixture pricing record' },
    { asOf: '2026-07-31', source: '   ' },
  ])('rejects invalid pricing provenance %#', (pricingProvenance) => {
    expect(DetectedModelSchema.safeParse({ id: 'model-1', pricingProvenance }).success).toBe(false);
  });

  it('clones pricing provenance without sharing the nested object', () => {
    const original = {
      id: 'model-1',
      pricingInput: 1,
      pricingProvenance: {
        asOf: '2026-07-31',
        source: 'test fixture pricing record',
      },
    };

    const cloned = cloneDetectedModel(original);
    if (!cloned.pricingProvenance) throw new Error('Expected cloned pricing provenance');
    cloned.pricingProvenance.source = 'updated test fixture pricing record';

    expect(original.pricingProvenance).toEqual({
      asOf: '2026-07-31',
      source: 'test fixture pricing record',
    });
  });

  it('round-trips and clones exact native catalog metadata without changing selection identity', () => {
    const original = {
      id: 'gpt-5.6-sol',
      displayName: 'GPT-5.6 Sol',
      nativeOrder: 2,
      nativeDefault: true,
      nativeHidden: false,
      nativeReasoningEfforts: ['low', 'medium', 'high', 'xhigh'],
      supportsReasoning: true,
    };

    const roundTripped = DetectedModelSchema.parse(JSON.parse(JSON.stringify(original)) as unknown);
    const cloned = cloneDetectedModel(roundTripped);
    if (!cloned.nativeReasoningEfforts) throw new Error('Expected cloned native reasoning efforts');

    expect(roundTripped).toMatchObject({
      id: 'gpt-5.6-sol',
      displayName: 'GPT-5.6 Sol',
      nativeOrder: 2,
      nativeDefault: true,
      nativeHidden: false,
      nativeReasoningEfforts: ['low', 'medium', 'high', 'xhigh'],
    });
    expect(cloned.nativeReasoningEfforts).toEqual(['low', 'medium', 'high', 'xhigh']);
    expect(cloned.nativeReasoningEfforts).not.toBe(roundTripped.nativeReasoningEfforts);
  });

  it('reads a model without runtime metadata as unknown load state and keeps ceilings apart from active context', () => {
    const legacy = {
      id: 'qwen3-coder',
      maximumContextTokens: 262_144,
      maximumOutputTokens: 32_768,
    };

    const parsed = DetectedModelSchema.parse(legacy);
    const cloned = cloneDetectedModel(parsed);

    expect(parsed).toEqual(legacy);
    expect(parsed.runtime).toBeUndefined();
    expect(parsed.effectiveContextTokens).toBeUndefined();
    expect(cloned).toEqual(legacy);
    expect(cloned.effectiveContextTokens).toBeUndefined();
  });

  it('round-trips runtime load state with exact instance identifiers', () => {
    const model = {
      id: 'qwen/qwen3-coder-30b',
      maximumContextTokens: 262_144,
      effectiveContextTokens: 32_768,
      runtime: {
        loadState: 'loaded',
        observedAt: 1_786_000_000_000,
        instances: [
          { id: 'qwen/qwen3-coder-30b', effectiveContextTokens: 32_768 },
          { id: 'qwen/qwen3-coder-30b:2' },
        ],
      },
    } as const;

    expect(DetectedModelSchema.parse(JSON.parse(JSON.stringify(model)) as unknown)).toEqual(model);
    for (const loadState of ['not-loaded', 'unknown'] as const) {
      expect(
        DetectedModelSchema.safeParse({ id: 'm', runtime: { loadState, observedAt: 0 } }).success,
      ).toBe(true);
    }
  });

  it.each([
    ['an unknown load state', { loadState: 'warming', observedAt: 0 }],
    ['a negative observation time', { loadState: 'loaded', observedAt: -1 }],
    ['a missing observation time', { loadState: 'loaded' }],
    ['an empty instance id', { loadState: 'loaded', observedAt: 0, instances: [{ id: '' }] }],
    [
      'a zero instance context',
      { loadState: 'loaded', observedAt: 0, instances: [{ id: 'a', effectiveContextTokens: 0 }] },
    ],
    [
      'a fractional instance context',
      { loadState: 'loaded', observedAt: 0, instances: [{ id: 'a', effectiveContextTokens: 1.5 }] },
    ],
    ['an unknown runtime key', { loadState: 'loaded', observedAt: 0, extra: true }],
    [
      'an unknown instance key',
      { loadState: 'loaded', observedAt: 0, instances: [{ id: 'a', extra: true }] },
    ],
  ])('rejects runtime metadata with %s', (_label, runtime) => {
    expect(DetectedModelSchema.safeParse({ id: 'model-1', runtime }).success).toBe(false);
  });

  it('clones runtime metadata without sharing nested instances', () => {
    const original = DetectedModelSchema.parse({
      id: 'model-1',
      runtime: {
        loadState: 'loaded',
        observedAt: 1,
        instances: [{ id: 'model-1:1', effectiveContextTokens: 8_192 }],
      },
    });

    const cloned = cloneDetectedModel(original);

    expect(cloned).toEqual(original);
    expect(cloned.runtime).not.toBe(original.runtime);
    expect(cloned.runtime?.instances).not.toBe(original.runtime?.instances);
    expect(cloned.runtime?.instances?.[0]).not.toBe(original.runtime?.instances?.[0]);
  });
});
