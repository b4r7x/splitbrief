import { describe, expect, it } from 'vitest';
import { cliDetectionFor } from '#testing/helpers/factories/detection.js';
import type {
  CliProviderAuthFact,
  CliToolDetection,
  ProviderDetection,
} from '../../../core/discovery/detection.js';
import {
  API_PROVIDER_CATALOG,
  type ApiProviderDescriptor,
  type ApiProviderId,
} from '../../../core/providers/api-provider-catalog.js';
import { CLI_TOOL_CATALOG } from '../../../core/runners/cli-tool-catalog.js';
import type { ConfiguredProviderRuntime } from '../../../engine/detection/provider-outcomes.js';
import {
  deriveApiStatus,
  deriveCliStatus,
  isSelectable,
  type PickerDetectionSnapshot,
} from './status.js';

const KILO_FACTS: readonly CliProviderAuthFact[] = [
  { provider: 'GitHub Copilot', source: 'oauth' },
  { provider: 'Alibaba Coding Plan', source: 'api' },
  { provider: 'OpenAI', source: 'env', envVar: 'OPENAI_API_KEY' },
];

function snapshot(detection: CliToolDetection): PickerDetectionSnapshot {
  return { cliTools: [detection], providers: [] };
}

describe('deriveCliStatus with per-provider facts', () => {
  it('resolves ready with the configured provider names when the listing has entries', () => {
    const detection = cliDetectionFor('ready', 'kilo-code', {
      providerAuth: { kind: 'read', facts: KILO_FACTS },
    });

    const status = deriveCliStatus(CLI_TOOL_CATALOG['kilo-code'], snapshot(detection));

    expect(status).toEqual({
      state: 'ready',
      remediation: null,
      configuredProviders: ['GitHub Copilot', 'Alibaba Coding Plan', 'OpenAI'],
    });
  });

  it('lists a provider once when it is stored and also recognized via an env var', () => {
    const detection = cliDetectionFor('ready', 'opencode', {
      providerAuth: {
        kind: 'read',
        facts: [
          { provider: 'OpenAI', source: 'oauth' },
          { provider: 'OpenCode Go', source: 'api' },
          { provider: 'Kimi For Coding', source: 'env', envVar: 'KIMI_API_KEY' },
          { provider: 'Ollama Cloud', source: 'env', envVar: 'OLLAMA_API_KEY' },
          { provider: 'OpenAI', source: 'env', envVar: 'OPENAI_API_KEY' },
        ],
      },
    });

    const status = deriveCliStatus(CLI_TOOL_CATALOG.opencode, snapshot(detection));

    expect(status).toEqual({
      state: 'ready',
      remediation: null,
      configuredProviders: ['OpenAI', 'OpenCode Go', 'Kimi For Coding', 'Ollama Cloud'],
    });
  });

  it('lets a non-empty listing outrank a stale presence-derived auth diagnostic', () => {
    const detection = cliDetectionFor('unauthenticated', 'kilo-code', {
      providerAuth: { kind: 'read', facts: [{ provider: 'GitHub Copilot', source: 'oauth' }] },
    });

    const status = deriveCliStatus(CLI_TOOL_CATALOG['kilo-code'], snapshot(detection));

    expect(status).toEqual({
      state: 'ready',
      remediation: null,
      configuredProviders: ['GitHub Copilot'],
    });
  });

  it('resolves a truthful zero-provider listing as unauthenticated with sign-in remediation', () => {
    const detection = cliDetectionFor('unauthenticated', 'kilo-code', {
      providerAuth: { kind: 'empty' },
    });

    const status = deriveCliStatus(CLI_TOOL_CATALOG['kilo-code'], snapshot(detection));

    expect(status).toEqual({
      state: 'unauthenticated',
      remediation: 'Sign in or configure a provider - free models require sign-in.',
    });
  });

  it('keeps the presence-derived remediation when no facts exist (legacy cache)', () => {
    const detection = cliDetectionFor('unauthenticated', 'kilo-code');

    const status = deriveCliStatus(CLI_TOOL_CATALOG['kilo-code'], snapshot(detection));

    expect(status).toEqual({
      state: 'unauthenticated',
      remediation: detection.diagnostic.remediation,
    });
  });

  it('keeps presence-derived readiness bare when no facts exist (oracle fallback)', () => {
    const detection = cliDetectionFor('ready', 'opencode');

    const status = deriveCliStatus(CLI_TOOL_CATALOG.opencode, snapshot(detection));

    expect(status).toEqual({ state: 'ready', remediation: null });
  });

  it('never upgrades a non-auth blocker, even with a non-empty listing', () => {
    const detection = cliDetectionFor('incompatible', 'kilo-code', {
      providerAuth: { kind: 'read', facts: [{ provider: 'GitHub Copilot', source: 'oauth' }] },
    });

    const status = deriveCliStatus(CLI_TOOL_CATALOG['kilo-code'], snapshot(detection));

    expect(status).toEqual({
      state: 'incompatible',
      remediation: detection.diagnostic.remediation,
    });
  });
});

const OLLAMA = API_PROVIDER_CATALOG.ollama;
const LM_STUDIO = API_PROVIDER_CATALOG['lm-studio'];
const LLAMA_CPP = API_PROVIDER_CATALOG['llama-cpp'];

function providerSnapshot(
  detection: ProviderDetection,
  hasApiKeyOverride: (provider: string) => boolean = () => false,
): PickerDetectionSnapshot {
  return { cliTools: [], providers: [detection], hasApiKeyOverride };
}

function runtimeFor(
  provider: ApiProviderId,
  runtime: Omit<ConfiguredProviderRuntime, 'connection'>,
): ConfiguredProviderRuntime {
  return {
    connection: { role: 'planner', provider, contextKey: `${provider}|planner` },
    ...runtime,
  };
}

function runtimeSnapshot(
  runtime: ConfiguredProviderRuntime,
  hasApiKeyOverride: (provider: string) => boolean = () => false,
): PickerDetectionSnapshot {
  return { cliTools: [], providers: [], providerOutcomes: [runtime], hasApiKeyOverride };
}

const FAILED = {
  state: 'failed',
  catalog: null,
  models: null,
  fetchedAt: null,
  validatedAt: 1_800_000,
} as const;

describe('deriveApiStatus separates a local server failure from an auth failure', () => {
  it('reads an offline configured Ollama as unavailable, never as unauthenticated', () => {
    const status = deriveApiStatus(
      OLLAMA,
      runtimeSnapshot(
        runtimeFor('ollama', { ...FAILED, failure: 'offline', diagnostic: 'connection refused' }),
      ),
      'planner',
    );

    expect(status).toEqual({ state: 'unavailable', remediation: 'connection refused' });
  });

  it('keeps a timed-out no-auth server on the availability axis without a key', () => {
    const status = deriveApiStatus(
      OLLAMA,
      runtimeSnapshot(
        runtimeFor('ollama', { ...FAILED, failure: 'timeout', diagnostic: 'Request timed out' }),
      ),
      'planner',
    );

    expect(status).toEqual({ state: 'unavailable', remediation: 'Request timed out' });
  });

  it.each(['malformed', 'request-failed', undefined] as const)(
    'keeps an optional-key server unavailable when the probe reports %s',
    (failure) => {
      const status = deriveApiStatus(
        LM_STUDIO,
        runtimeSnapshot(
          runtimeFor('lm-studio', {
            ...FAILED,
            ...(failure === undefined ? {} : { failure }),
            diagnostic: 'Provider model discovery failed.',
          }),
        ),
        'planner',
      );

      expect(status).toEqual({
        state: 'unavailable',
        remediation: 'Provider model discovery failed.',
      });
    },
  );

  it('reads a configured LM Studio 401 as unauthenticated', () => {
    const status = deriveApiStatus(
      LM_STUDIO,
      runtimeSnapshot(
        runtimeFor('lm-studio', {
          ...FAILED,
          failure: 'invalid-credential',
          diagnostic: 'HTTP 401',
        }),
      ),
      'planner',
    );

    expect(status).toEqual({
      state: 'unauthenticated',
      remediation: 'lm-studio rejected the configured key.',
    });
  });

  it('reads a configured LM Studio 403 as unauthenticated, not as a provider policy', () => {
    const status = deriveApiStatus(
      LM_STUDIO,
      runtimeSnapshot(
        runtimeFor('lm-studio', { ...FAILED, failure: 'policy-denied', diagnostic: 'HTTP 403' }),
      ),
      'planner',
    );

    expect(status).toEqual({
      state: 'unauthenticated',
      remediation: 'lm-studio rejected the configured key.',
    });
  });

  it('classifies an ambient 401 before the local start-the-server fallback', () => {
    const status = deriveApiStatus(
      LM_STUDIO,
      providerSnapshot({
        provider: 'lm-studio',
        available: false,
        isLocal: true,
        failure: 'invalid-credential',
        error: 'HTTP 401',
      }),
    );

    expect(status).toEqual({
      state: 'unauthenticated',
      remediation: 'lm-studio rejected the configured key.',
    });
  });

  it('still tells the operator to start a local server that never answered', () => {
    const status = deriveApiStatus(
      OLLAMA,
      providerSnapshot({
        provider: 'ollama',
        available: false,
        isLocal: true,
        failure: 'offline',
        error: 'fetch failed',
      }),
    );

    expect(status).toEqual({ state: 'unavailable', remediation: 'fetch failed' });
  });

  it('never lets a stale catalog become ready, whatever it still lists', () => {
    const status = deriveApiStatus(
      OLLAMA,
      runtimeSnapshot(
        runtimeFor('ollama', {
          state: 'stale',
          catalog: 'populated',
          models: [],
          fetchedAt: 1_700_000,
          validatedAt: 1_800_000,
          failure: 'offline',
          diagnostic: 'connection refused',
        }),
      ),
      'planner',
    );

    expect(status).toEqual({
      state: 'unavailable',
      remediation: 'Last confirmed ollama catalog is stale. Refresh detection.',
    });
  });

  it('does not let a fresh empty catalog imply a selectable model', () => {
    const status = deriveApiStatus(
      OLLAMA,
      runtimeSnapshot(
        runtimeFor('ollama', {
          state: 'fresh',
          catalog: 'empty',
          models: [],
          fetchedAt: 1_800_000,
          validatedAt: 1_800_000,
        }),
      ),
      'planner',
    );

    expect(status).toEqual({
      state: 'unavailable',
      remediation:
        'ollama is reachable but lists no models. Install or load one, then refresh detection.',
    });
    expect(isSelectable(status, 'api')).toBe(false);
  });

  it('reads a fresh populated catalog as ready', () => {
    const status = deriveApiStatus(
      OLLAMA,
      runtimeSnapshot(
        runtimeFor('ollama', {
          state: 'fresh',
          catalog: 'populated',
          models: [],
          fetchedAt: 1_800_000,
          validatedAt: 1_800_000,
        }),
      ),
      'planner',
    );

    expect(status).toEqual({ state: 'ready', remediation: null });
  });
});

describe('deriveApiStatus qualification gating', () => {
  it('lets the beta local llama.cpp profile reach its configured catalog', () => {
    expect(LLAMA_CPP.compatibility).toBe('beta');

    const status = deriveApiStatus(
      LLAMA_CPP,
      runtimeSnapshot(
        runtimeFor('llama-cpp', {
          state: 'fresh',
          catalog: 'populated',
          models: [],
          fetchedAt: 1_800_000,
          validatedAt: 1_800_000,
        }),
      ),
      'planner',
    );

    expect(status).toEqual({ state: 'ready', remediation: null });
  });

  it('reports the beta local profile connection facts rather than a qualification gate', () => {
    const status = deriveApiStatus(
      LLAMA_CPP,
      runtimeSnapshot(
        runtimeFor('llama-cpp', {
          ...FAILED,
          failure: 'offline',
          diagnostic: 'connection refused',
        }),
      ),
      'planner',
    );

    expect(status).toEqual({ state: 'unavailable', remediation: 'connection refused' });
  });

  it('gates a remote beta descriptor exactly as an unverified one', () => {
    const remoteBeta: ApiProviderDescriptor = {
      ...LLAMA_CPP,
      locality: 'remote',
      category: 'remote-api',
      offering: 'payg',
    };

    expect(deriveApiStatus(remoteBeta, runtimeSnapshot(runtimeFor('llama-cpp', FAILED)))).toEqual({
      state: 'unverified',
      remediation: `llama-cpp has no passing provider conformance evidence as of ${LLAMA_CPP.asOf}. Select a verified provider, or re-run \`scripts/provider-conformance.ts\` with a credential to qualify it.`,
    });
  });

  it.each(['unknown', 'unverified'] as const)(
    'keeps a %s local descriptor gated',
    (compatibility) => {
      const gated: ApiProviderDescriptor = { ...LLAMA_CPP, compatibility };

      expect(
        deriveApiStatus(gated, runtimeSnapshot(runtimeFor('llama-cpp', FAILED))),
      ).toMatchObject({
        state: 'unverified',
      });
    },
  );

  it('keeps an incompatible local descriptor gated', () => {
    const gated: ApiProviderDescriptor = { ...LLAMA_CPP, compatibility: 'incompatible' };

    expect(deriveApiStatus(gated, runtimeSnapshot(runtimeFor('llama-cpp', FAILED)))).toEqual({
      state: 'incompatible',
      remediation: `llama-cpp failed provider conformance as of ${LLAMA_CPP.asOf}. Select a verified provider.`,
    });
  });
});
