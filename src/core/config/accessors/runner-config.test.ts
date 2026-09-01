import { describe, expect, it } from 'vitest';
import {
  getPlannerToolId,
  getRunnerCatalogDisplayName,
  getRunnerDisplayName,
  resolveRunnerConfigContext,
} from './runner-config.js';
import { projectRunnerDiscoveryContext } from './runner-discovery-context.js';
import { createDefaultConfig } from '../load/defaults.js';
import type { PlannerConfig } from '../../schemas/planner-config.js';
import type { Config } from '../../schemas/config.js';

function keyedEndpointConfig(input: { plannerApiKey: string; implementerApiKey: string }): Config {
  return {
    ...createDefaultConfig(),
    planner: {
      kind: 'api',
      provider: 'custom-endpoint',
      service: 'custom-endpoint',
      offering: 'payg',
      apiBase: 'https://API.EXAMPLE.TEST:443/v1/',
      apiKey: input.plannerApiKey,
      model: 'claude-opus-4-6',
    },
    implementer: {
      kind: 'api',
      provider: 'custom-endpoint',
      service: 'custom-endpoint',
      offering: 'payg',
      apiBase: 'https://API.EXAMPLE.TEST:443/v1/',
      apiKey: input.implementerApiKey,
      model: 'claude-sonnet-4-6',
    },
  };
}

type ProfiledConfig = Config & {
  implementerProfiles: NonNullable<Config['implementerProfiles']>;
};

function inlineProfileConfig(apiKey: string): ProfiledConfig {
  return {
    ...keyedEndpointConfig({ plannerApiKey: apiKey, implementerApiKey: apiKey }),
    implementerProfiles: {
      default: 'primary',
      profiles: {
        primary: {
          kind: 'api',
          provider: 'custom-endpoint',
          service: 'custom-endpoint',
          offering: 'payg',
          apiBase: 'https://api.example.test/v1',
          apiKey,
          model: 'claude-sonnet-4-6',
        },
        secondary: {
          kind: 'api',
          provider: 'custom-endpoint',
          service: 'custom-endpoint',
          offering: 'payg',
          apiBase: 'https://api.example.test/v1',
          apiKey,
          model: 'claude-haiku-4-5',
        },
      },
    },
  };
}

describe('getPlannerToolId', () => {
  it('returns the tool for cli kind', () => {
    const config: PlannerConfig = { kind: 'cli', tool: 'claude-code' };
    expect(getPlannerToolId(config)).toBe('claude-code');
  });

  it('falls back to shell for api kind, which names no planner tool', () => {
    const config: PlannerConfig = {
      kind: 'api',
      provider: 'my-custom',
      service: 'my-custom',
      offering: 'payg',
      apiBase: 'http://localhost:9999/v1',
      model: 'my-model',
    };
    expect(getPlannerToolId(config)).toBe('shell');
  });

  it('returns shell for shell kind', () => {
    const config: PlannerConfig = { kind: 'shell', command: 'my-planner' };
    expect(getPlannerToolId(config)).toBe('shell');
  });

  it('returns agent (not shell) for agent kind', () => {
    const config: PlannerConfig = { kind: 'agent', command: 'my-agent' };
    expect(getPlannerToolId(config)).toBe('agent');
  });
});

describe('getRunnerCatalogDisplayName maps runners to catalog display names', () => {
  it('cli opencode → OpenCode CLI', () => {
    const config: PlannerConfig = { kind: 'cli', tool: 'opencode' };
    expect(getRunnerCatalogDisplayName(config)).toBe('OpenCode CLI');
  });

  it('api ollama → Ollama', () => {
    const config: PlannerConfig = {
      kind: 'api',
      provider: 'ollama',
      service: 'ollama',
      offering: 'local',
      apiBase: 'http://localhost:11434/v1',
      model: 'qwen3-coder:30b',
    };
    expect(getRunnerCatalogDisplayName(config)).toBe('Ollama');
  });

  it('shell → Custom Shell', () => {
    const config: PlannerConfig = { kind: 'shell', command: 'my-planner' };
    expect(getRunnerCatalogDisplayName(config)).toBe('Custom Shell');
  });

  it('agent → Agent', () => {
    const config: PlannerConfig = { kind: 'agent', command: 'my-agent' };
    expect(getRunnerCatalogDisplayName(config)).toBe('Agent');
  });
});

describe('getRunnerDisplayName still returns raw lowercase ids', () => {
  it('cli opencode → opencode', () => {
    const config: PlannerConfig = { kind: 'cli', tool: 'opencode' };
    expect(getRunnerDisplayName(config)).toBe('opencode');
  });
});

describe('projectRunnerDiscoveryContext', () => {
  it('is reproducible across processes: equal content yields an equal context', () => {
    const left = projectRunnerDiscoveryContext({ config: createDefaultConfig(), role: 'planner' });
    const right = projectRunnerDiscoveryContext({ config: createDefaultConfig(), role: 'planner' });
    expect(left.configGeneration).toBe(right.configGeneration);
    expect(left).toEqual(right);
  });

  it('keys the reviewer seat as the planner so detection evidence is shared', () => {
    const config: Config = {
      ...createDefaultConfig(),
      planner: { kind: 'cli', tool: 'claude-code' },
    };

    expect(projectRunnerDiscoveryContext({ config, role: 'reviewer' }).role).toBe('planner');
  });

  it('projects the effective CLI channel without changing legacy or explicit selections', () => {
    const legacyConfig: Config = {
      ...createDefaultConfig(),
      planner: { kind: 'cli', tool: 'claude-code' },
    };
    const sessionConfig: Config = {
      ...legacyConfig,
      planner: { kind: 'cli', tool: 'claude-code', authChannel: 'session' },
    };
    const apiKeyConfig: Config = {
      ...legacyConfig,
      planner: { kind: 'cli', tool: 'claude-code', authChannel: 'api-key' },
    };

    const legacy = projectRunnerDiscoveryContext({ config: legacyConfig, role: 'planner' });
    const legacyAgain = projectRunnerDiscoveryContext({ config: legacyConfig, role: 'planner' });

    expect(legacyConfig.planner).toEqual({ kind: 'cli', tool: 'claude-code' });
    expect(legacy.authChannel).toBe('session');
    expect(legacyAgain.configGeneration).toBe(legacy.configGeneration);
    expect(
      projectRunnerDiscoveryContext({ config: sessionConfig, role: 'planner' }).authChannel,
    ).toBe('session');
    expect(
      projectRunnerDiscoveryContext({ config: apiKeyConfig, role: 'planner' }).authChannel,
    ).toBe('api-key');
  });

  it('projects custom endpoints and credentials without serializing their raw values', () => {
    const rawInlineCredential = 'sk-test-inline-credential';
    const config: Config = {
      ...createDefaultConfig(),
      planner: {
        kind: 'api',
        provider: 'custom-gateway',
        service: 'custom-gateway',
        offering: 'payg',
        apiBase: 'https://gateway.example.test/v1',
        apiKey: rawInlineCredential,
        model: 'custom-model',
      },
    };

    const projected = projectRunnerDiscoveryContext({ config, role: 'planner' });
    const serialized = JSON.stringify(projected);

    expect(projected).toMatchObject({
      role: 'planner',
      kind: 'api',
      id: 'custom-gateway',
      model: 'custom-model',
      authChannel: 'api-key',
      endpointOrigin: 'https://gateway.example.test',
      credentialPresent: true,
      credentialDomain: {
        providerId: 'custom-gateway',
        endpointOrigin: 'https://gateway.example.test',
        authChannel: 'api-key',
        credentialSource: { kind: 'inline' },
      },
    });
    expect(serialized).not.toContain(rawInlineCredential);
    expect(serialized).not.toContain('apiKey');

    const envConfig: Config = {
      ...createDefaultConfig(),
      planner: {
        kind: 'api',
        provider: 'custom-gateway',
        service: 'custom-gateway',
        offering: 'payg',
        apiBase: 'https://gateway.example.test/v1',
        apiKey: 'env:CUSTOM_GATEWAY_API_KEY',
        model: 'custom-model',
      },
    };
    expect(projectRunnerDiscoveryContext({ config: envConfig, role: 'planner' })).toMatchObject({
      credentialPresent: true,
      credentialDomain: {
        credentialSource: { kind: 'env', name: 'CUSTOM_GATEWAY_API_KEY' },
      },
    });
  });

  it('keeps credential-domain equality exact and generation-scoped', () => {
    const config = keyedEndpointConfig({
      plannerApiKey: 'env:CUSTOM_ENDPOINT_API_KEY',
      implementerApiKey: 'env:CUSTOM_ENDPOINT_API_KEY',
    });
    const planner = projectRunnerDiscoveryContext({ config, role: 'planner' });
    const implementer = projectRunnerDiscoveryContext({ config, role: 'implementer' });

    expect(planner.credentialDomain?.endpointOrigin).toBe('https://api.example.test');
    expect(planner.credentialDomain).toEqual(implementer.credentialDomain);

    const differentEnv = keyedEndpointConfig({
      plannerApiKey: 'env:CUSTOM_ENDPOINT_API_KEY',
      implementerApiKey: 'env:OTHER_CUSTOM_ENDPOINT_KEY',
    });
    expect(
      projectRunnerDiscoveryContext({ config: differentEnv, role: 'planner' }).credentialDomain,
    ).not.toEqual(
      projectRunnerDiscoveryContext({ config: differentEnv, role: 'implementer' }).credentialDomain,
    );

    const inline = keyedEndpointConfig({
      plannerApiKey: 'sk-test-planner',
      implementerApiKey: 'sk-test-implementer',
    });
    const inlinePlanner = projectRunnerDiscoveryContext({ config: inline, role: 'planner' });
    expect(inlinePlanner.credentialDomain).toEqual(
      projectRunnerDiscoveryContext({ config: inline, role: 'planner' }).credentialDomain,
    );
    expect(inlinePlanner.credentialDomain).not.toEqual(
      projectRunnerDiscoveryContext({ config: inline, role: 'implementer' }).credentialDomain,
    );

    const sessionConfig: Config = {
      ...config,
      planner: { kind: 'cli', tool: 'claude-code', authChannel: 'session' },
    };
    // A session-authenticated CLI seat carries no credential domain at all, so
    // it can never share one with the keyed implementer beside it.
    expect(
      projectRunnerDiscoveryContext({ config: sessionConfig, role: 'planner' }).credentialDomain,
    ).toBeUndefined();

    // Generation is content-derived: a structural clone keeps the domain, and
    // only a real config change breaks it — that stability is what lets a
    // restarted process read the detection cache its predecessor wrote.
    const clone = structuredClone(config);
    expect(planner.credentialDomain).toEqual(
      projectRunnerDiscoveryContext({ config: clone, role: 'planner' }).credentialDomain,
    );
    const changed: Config = {
      ...config,
      planner: { ...config.planner, model: 'claude-opus-4-5' },
    };
    expect(planner.credentialDomain).not.toEqual(
      projectRunnerDiscoveryContext({ config: changed, role: 'planner' }).credentialDomain,
    );
  });

  it('keeps resolved profile inline credential identity stable and source-specific', () => {
    const rawInlineCredential = 'sk-test-resolved-profile';
    const config = inlineProfileConfig(rawInlineCredential);

    const primary = projectRunnerDiscoveryContext({ config, role: 'implementer' });
    const primaryAgain = projectRunnerDiscoveryContext({ config, role: 'implementer' });

    expect(primary).toMatchObject({ kind: 'api', id: 'custom-endpoint', credentialPresent: true });
    expect(primary.credentialDomain).toEqual(primaryAgain.credentialDomain);
    expect(JSON.stringify(primary)).not.toContain(rawInlineCredential);

    const planner = projectRunnerDiscoveryContext({ config, role: 'planner' });
    expect(planner.credentialDomain).not.toEqual(primary.credentialDomain);

    config.implementerProfiles.default = 'secondary';
    const secondary = projectRunnerDiscoveryContext({ config, role: 'implementer' });
    // Switching the default profile is a content change, so the generation moves.
    expect(primary.configGeneration).not.toBe(secondary.configGeneration);
    expect(primary.credentialDomain).not.toEqual(secondary.credentialDomain);

    // A structural clone carries the same content-derived identity forward.
    const clone = structuredClone(config);
    expect(secondary.credentialDomain).toEqual(
      projectRunnerDiscoveryContext({ config: clone, role: 'implementer' }).credentialDomain,
    );
  });
});

describe('resolveRunnerConfigContext', () => {
  it('keeps planner named implementer and intermediate sources in distinct slots', () => {
    const planner = { kind: 'cli', tool: 'claude-code' } as const;
    const implementer = { kind: 'cli', tool: 'codex' } as const;
    const intermediate = {
      kind: 'api',
      provider: 'custom-endpoint',
      service: 'custom-endpoint',
      offering: 'payg',
      apiBase: 'https://api.example.test/v1',
      apiKey: 'test-key',
      model: 'custom-model',
    } as const;

    expect(resolveRunnerConfigContext({ role: 'planner', runner: planner })).toEqual({
      slot: { role: 'planner' },
      runner: planner,
    });
    expect(
      resolveRunnerConfigContext({ role: 'implementer', profile: 'fast', runner: implementer }),
    ).toEqual({
      slot: { role: 'implementer', profile: 'fast' },
      runner: implementer,
    });
    expect(resolveRunnerConfigContext({ role: 'intermediate', runner: intermediate })).toEqual({
      slot: { role: 'intermediate' },
      runner: intermediate,
    });
  });
});
