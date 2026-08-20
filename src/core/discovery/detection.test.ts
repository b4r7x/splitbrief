import { describe, expect, it } from 'vitest';
import { API_PROVIDER_CATALOG, KNOWN_API_PROVIDER_IDS } from '../providers/api-provider-catalog.js';
import { CLI_TOOL_IDS } from '../runners/cli-tool-catalog.js';
import {
  CLI_READINESS_STATES,
  CliExecutableFingerprintSchema,
  CliToolDetectionSchema,
  DetectedModelSchema,
  DetectedPricingProvenanceSchema,
  DetectedPricingTierSchema,
  PROVIDER_DETECTION_FAILURE_KINDS,
  ProviderDetectionSchema,
  formatDigestBoundExecutableFingerprint,
  parseDigestBoundExecutableFingerprint,
  type CliCompatibilityState,
  type CliDiagnostic,
  type CliToolDetection,
  type CliReadinessState,
  type CliTrustState,
  type DetectedPricingProvenance,
} from './detection.js';
import { cloneDetectedModel } from './clone-model.js';

const TRUST_STATES: readonly CliTrustState[] = ['trusted', 'untrusted', 'not-checked'];
const COMPATIBILITY_STATES: readonly CliCompatibilityState[] = [
  'compatible',
  'incompatible',
  'unverified',
  'not-checked',
];

const executable = {
  path: '/opt/splitbrief/bin/codex',
  fingerprint: { dev: 1, ino: 2, size: 3, mtimeMs: 4 },
};

function detectionFor(state: CliReadinessState): CliToolDetection {
  const diagnostic: CliDiagnostic =
    state === 'ready'
      ? { state, remediation: null }
      : { state, remediation: `Resolve ${state} readiness` };

  return {
    tool: 'codex',
    executable: state === 'unavailable' ? null : executable,
    trust:
      state === 'untrusted' ? 'untrusted' : state === 'unavailable' ? 'not-checked' : 'trusted',
    installedVersion: state === 'unavailable' ? null : '0.40.0',
    testedVersion: '0.40.0',
    compatibility:
      state === 'incompatible'
        ? 'incompatible'
        : state === 'unverified'
          ? 'unverified'
          : state === 'unavailable'
            ? 'not-checked'
            : 'compatible',
    auth:
      state === 'unauthenticated'
        ? 'unauthenticated'
        : state === 'unavailable'
          ? 'not-checked'
          : 'authenticated',
    diagnostic,
    probedAt: 1_786_000_000_000,
  };
}

describe('detection schemas', () => {
  it('fingerprints an executable whose inode exceeds the safe integer range', () => {
    // Every executable on the macOS Sealed System Volume — /bin/sh included —
    // reports an inode above Number.MAX_SAFE_INTEGER.
    const ino = 1_152_921_500_312_522_400;
    expect(Number.isSafeInteger(ino)).toBe(false);
    const fingerprint = { dev: 16_777_233, ino, size: 101_232, mtimeMs: 1_746_337_162_000 };

    expect(CliExecutableFingerprintSchema.safeParse(fingerprint).success).toBe(true);
    const bound = formatDigestBoundExecutableFingerprint({
      fingerprint,
      contentDigest: 'b'.repeat(64),
    });
    expect(bound).not.toBeNull();
    expect(parseDigestBoundExecutableFingerprint(bound ?? '')).toEqual(fingerprint);
    expect(CliExecutableFingerprintSchema.safeParse({ ...fingerprint, ino: 1.5 }).success).toBe(
      false,
    );
    expect(CliExecutableFingerprintSchema.safeParse({ ...fingerprint, ino: -1 }).success).toBe(
      false,
    );
  });

  it('accepts per-provider oracle facts as an additive, legacy-tolerant field', () => {
    const legacy = detectionFor('ready');
    expect(CliToolDetectionSchema.parse(legacy).providerAuth).toBeUndefined();

    const withFacts = {
      ...legacy,
      providerAuth: [
        { provider: 'GitHub Copilot', source: 'oauth' },
        { provider: 'Alibaba Coding Plan', source: 'api' },
        { provider: 'OpenAI', source: 'env', envVar: 'OPENAI_API_KEY' },
      ],
    };
    expect(CliToolDetectionSchema.parse(withFacts)).toEqual(withFacts);
    expect(
      CliToolDetectionSchema.safeParse({
        ...legacy,
        providerAuth: [{ provider: 'OpenAI', source: 'oauth', apiKey: 'sk-secret' }],
      }).success,
    ).toBe(false);
    expect(
      CliToolDetectionSchema.safeParse({
        ...legacy,
        providerAuth: [{ provider: '', source: 'oauth' }],
      }).success,
    ).toBe(false);
  });

  it('round-trips provider model metadata, pricing tiers, and pricing provenance', () => {
    const pricingProvenance: DetectedPricingProvenance = {
      asOf: '2026-07-31',
      source: 'test fixture pricing record',
    };
    const detection = {
      provider: 'openai',
      available: true,
      models: [
        {
          id: 'model-1',
          contextLength: 200_000,
          maxOutputTokens: 16_000,
          pricingInput: 2,
          pricingOutput: 8,
          pricingCacheRead: 0.2,
          pricingCacheWrite: 2.5,
          pricingTiers: [
            {
              type: 'context',
              thresholdTokens: 200_000,
              inputPer1M: 4,
              outputPer1M: 12,
              cacheReadPer1M: 0.4,
              cacheWritePer1M: 5,
            },
          ],
          pricingProvenance,
          isFree: false,
          supportsTemperature: true,
          supportsReasoning: true,
          supportsImages: true,
          capabilities: ['tools'],
          releaseDate: '2026-07-31',
        },
      ],
      isLocal: false,
      hasKey: true,
    } as const;

    expect(ProviderDetectionSchema.parse(JSON.parse(JSON.stringify(detection)) as unknown)).toEqual(
      detection,
    );
  });

  it.each(KNOWN_API_PROVIDER_IDS)('accepts API provider detection for %s', (provider) => {
    expect(
      ProviderDetectionSchema.safeParse({
        provider,
        available: true,
        isLocal: API_PROVIDER_CATALOG[provider].offering === 'local',
      }).success,
    ).toBe(true);
  });

  it.each(['claude-code', 'shell', 'agent-sdk'])(
    'rejects non-API runner ID %s as provider detection',
    (provider) => {
      expect(
        ProviderDetectionSchema.safeParse({
          provider,
          available: true,
          isLocal: false,
        }).success,
      ).toBe(false);
    },
  );

  it.each(PROVIDER_DETECTION_FAILURE_KINDS)('round-trips a %s provider failure', (failure) => {
    const detection = {
      provider: 'openai',
      available: false,
      isLocal: false,
      hasKey: true,
      failure,
      error: 'Provider model discovery failed.',
    } as const;

    expect(ProviderDetectionSchema.parse(JSON.parse(JSON.stringify(detection)) as unknown)).toEqual(
      detection,
    );
  });

  it('accepts cached provider payloads that predate the failure field', () => {
    const legacy = {
      provider: 'openai',
      available: false,
      isLocal: false,
      hasKey: false,
      error: 'Provider credential is not configured.',
    };

    const parsed = ProviderDetectionSchema.parse(legacy);
    expect(parsed).toEqual(legacy);
    expect(parsed.failure).toBeUndefined();
  });

  it('rejects provider failure values outside the known kinds', () => {
    expect(
      ProviderDetectionSchema.safeParse({
        provider: 'openai',
        available: false,
        isLocal: false,
        failure: 'unreachable',
      }).success,
    ).toBe(false);
  });

  it.each(CLI_TOOL_IDS)('accepts role-neutral CLI detection for %s', (tool) => {
    expect(
      CliToolDetectionSchema.safeParse({
        ...detectionFor('ready'),
        tool,
      }).success,
    ).toBe(true);
  });

  it('round-trips every picker readiness state without collapsing readiness facts', () => {
    expect(CLI_READINESS_STATES).toHaveLength(7);
    expect(TRUST_STATES).toEqual(['trusted', 'untrusted', 'not-checked']);
    expect(COMPATIBILITY_STATES).toEqual([
      'compatible',
      'incompatible',
      'unverified',
      'not-checked',
    ]);

    for (const state of CLI_READINESS_STATES) {
      const detection = detectionFor(state);
      const roundTripped = CliToolDetectionSchema.parse(
        JSON.parse(JSON.stringify(detection)) as unknown,
      );

      expect(roundTripped).toEqual(detection);
      expect(roundTripped.diagnostic.state).toBe(state);
    }
  });

  it('rejects unknown keys at every detection boundary', () => {
    const pricingProvenance = {
      asOf: '2026-07-31',
      source: 'test fixture pricing record',
    } as const;
    const pricingTier = {
      type: 'context',
      thresholdTokens: 200_000,
      inputPer1M: 2,
    } as const;
    const model = {
      id: 'model-1',
      pricingTiers: [pricingTier],
      pricingProvenance,
    };
    const provider = {
      provider: 'openai',
      available: true,
      models: [model],
      isLocal: false,
      hasKey: true,
    } as const;

    expect(DetectedPricingTierSchema.safeParse({ ...pricingTier, extra: true }).success).toBe(
      false,
    );
    expect(
      DetectedPricingProvenanceSchema.safeParse({ ...pricingProvenance, extra: true }).success,
    ).toBe(false);
    expect(DetectedModelSchema.safeParse({ ...model, extra: true }).success).toBe(false);
    expect(
      ProviderDetectionSchema.safeParse({
        ...provider,
        models: [{ ...model, pricingTiers: [{ ...pricingTier, extra: true }] }],
      }).success,
    ).toBe(false);
    expect(ProviderDetectionSchema.safeParse({ ...provider, extra: true }).success).toBe(false);
    expect(
      CliToolDetectionSchema.safeParse({ ...detectionFor('ready'), extra: true }).success,
    ).toBe(false);
    expect(
      CliToolDetectionSchema.safeParse({
        ...detectionFor('ready'),
        diagnostic: { state: 'ready', remediation: null, extra: true },
      }).success,
    ).toBe(false);
  });

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

  it('requires absolute executable identity and actionable non-ready diagnostics', () => {
    expect(
      CliToolDetectionSchema.safeParse({
        ...detectionFor('ready'),
        executable: { ...executable, path: 'bin/codex' },
      }).success,
    ).toBe(false);
    expect(
      CliToolDetectionSchema.safeParse({
        ...detectionFor('unavailable'),
        diagnostic: { state: 'unavailable', remediation: '' },
      }).success,
    ).toBe(false);
    expect(
      CliToolDetectionSchema.safeParse({
        ...detectionFor('disabled'),
        diagnostic: { state: 'disabled', remediation: 'x'.repeat(4_001) },
      }).success,
    ).toBe(false);
    expect(
      CliToolDetectionSchema.safeParse({
        ...detectionFor('ready'),
        diagnostic: { state: 'ready', remediation: 'Nothing to do' },
      }).success,
    ).toBe(false);
  });

  it.each([
    ['untrusted trust', { trust: 'untrusted' }],
    ['unchecked trust', { trust: 'not-checked' }],
    ['incompatible version', { compatibility: 'incompatible' }],
    ['unverified version', { compatibility: 'unverified' }],
    ['unchecked version', { compatibility: 'not-checked' }],
    ['unauthenticated auth', { auth: 'unauthenticated' }],
    ['unknown auth', { auth: 'unknown' }],
    ['unchecked auth', { auth: 'not-checked' }],
  ] satisfies ReadonlyArray<readonly [string, Partial<CliToolDetection>]>)(
    'rejects a ready diagnostic with %s facts',
    (_label, contradictoryFacts) => {
      expect(
        CliToolDetectionSchema.safeParse({
          ...detectionFor('ready'),
          ...contradictoryFacts,
        }).success,
      ).toBe(false);
    },
  );

  it('accepts a ready diagnostic when authentication is not required', () => {
    expect(
      CliToolDetectionSchema.safeParse({
        ...detectionFor('ready'),
        auth: 'not-required',
      }).success,
    ).toBe(true);
  });
});
