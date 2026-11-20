import { describe, expect, it } from 'vitest';
import { API_PROVIDER_CATALOG, KNOWN_API_PROVIDER_IDS } from '../../providers/api-catalog.js';
import { CLI_TOOL_IDS } from '../../runners/cli-tool/catalog.js';
import { DetectedModelSchema } from './model.js';
import {
  CLI_READINESS_STATES,
  CliCompatibilityStateSchema,
  CliToolDetectionSchema,
  CliTrustStateSchema,
  PROVIDER_DETECTION_FAILURE_KINDS,
  ProviderDetectionSchema,
  type CliCompatibilityState,
  type CliDiagnostic,
  type CliToolDetection,
  type CliReadinessState,
  type CliTrustState,
} from './tool.js';

const TRUST_STATES: readonly CliTrustState[] = ['trusted', 'untrusted', 'not-checked'];
const COMPATIBILITY_STATES: readonly CliCompatibilityState[] = [
  'compatible',
  'incompatible',
  'unverified',
  'timeout',
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
  it('carries each provider-auth arm and rejects a credential value inside one', () => {
    const base = detectionFor('ready');
    expect(CliToolDetectionSchema.parse(base).providerAuth).toBeUndefined();

    const facts = [
      { provider: 'GitHub Copilot', source: 'oauth' },
      { provider: 'Alibaba Coding Plan', source: 'api' },
      { provider: 'OpenAI', source: 'env', envVar: 'OPENAI_API_KEY' },
    ];
    for (const providerAuth of [
      { kind: 'read', facts },
      { kind: 'empty' },
      { kind: 'unreadable', reason: 'parse-failure' },
    ]) {
      expect(CliToolDetectionSchema.parse({ ...base, providerAuth })).toEqual({
        ...base,
        providerAuth,
      });
    }

    expect(
      CliToolDetectionSchema.safeParse({
        ...base,
        providerAuth: {
          kind: 'read',
          facts: [{ provider: 'OpenAI', source: 'oauth', apiKey: 'sk-secret' }],
        },
      }).success,
    ).toBe(false);
    expect(
      CliToolDetectionSchema.safeParse({
        ...base,
        providerAuth: { kind: 'unreadable', reason: 'ran-out-of-patience' },
      }).success,
    ).toBe(false);
    expect(
      CliToolDetectionSchema.safeParse({
        ...base,
        providerAuth: { kind: 'read', facts: [{ provider: '', source: 'oauth' }] },
      }).success,
    ).toBe(false);
  });

  it('round-trips provider model metadata', () => {
    const detection = {
      provider: 'ollama',
      available: true,
      models: [
        {
          id: 'model-1',
          contextLength: 200_000,
          maxOutputTokens: 16_000,

          supportsTemperature: true,
          supportsReasoning: true,
          supportsImages: true,
          capabilities: ['tools'],
          releaseDate: '2026-07-31',
        },
      ],
      isLocal: true,
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

  it.each(['claude-code', 'shell', 'agent'])(
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
      provider: 'ollama',
      available: false,
      isLocal: true,
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
      provider: 'ollama',
      available: false,
      isLocal: true,
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
        provider: 'ollama',
        available: false,
        isLocal: true,
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
    expect(CliTrustStateSchema.options).toEqual(TRUST_STATES);
    expect(CliCompatibilityStateSchema.options).toEqual(COMPATIBILITY_STATES);

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
    const model = {
      id: 'model-1',
    };
    const provider = {
      provider: 'ollama',
      available: true,
      models: [model],
      isLocal: true,
      hasKey: true,
    } as const;

    expect(DetectedModelSchema.safeParse({ ...model, extra: true }).success).toBe(false);
    expect(
      ProviderDetectionSchema.safeParse({
        ...provider,
        models: [{ ...model, extra: true }],
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
