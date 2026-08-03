import { describe, expect, it } from 'vitest';
import {
  getPlannerToolId,
  getRunnerCatalogDisplayName,
  getRunnerDisplayName,
  isSameCredentialDomain,
  projectRunnerDiscoveryContext,
} from './runner-config.js';
import { createDefaultConfig } from '../load/io.js';
import type { PlannerConfig } from '../../schemas/planner-config.js';
import type { Config } from '../../schemas/config.js';

function anthropicConfig(input: { plannerApiKey: string; implementerApiKey: string }): Config {
  return {
    ...createDefaultConfig(),
    planner: {
      kind: 'api',
      provider: 'anthropic',
      service: 'anthropic',
      offering: 'payg',
      apiBase: 'https://API.ANTHROPIC.COM:443/v1/',
      apiKey: input.plannerApiKey,
      model: 'claude-opus-4-6',
    },
    implementer: {
      kind: 'agent-sdk',
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
    ...anthropicConfig({ plannerApiKey: apiKey, implementerApiKey: apiKey }),
    implementerProfiles: {
      default: 'primary',
      profiles: {
        primary: {
          kind: 'api',
          provider: 'anthropic',
          service: 'anthropic',
          offering: 'payg',
          apiBase: 'https://api.anthropic.com/v1',
          apiKey,
          model: 'claude-sonnet-4-6',
        },
        secondary: {
          kind: 'api',
          provider: 'anthropic',
          service: 'anthropic',
          offering: 'payg',
          apiBase: 'https://api.anthropic.com/v1',
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

  it('returns the provider for api kind when it is a valid PlannerToolId', () => {
    const config: PlannerConfig = {
      kind: 'api',
      provider: 'anthropic',
      service: 'anthropic',
      offering: 'payg',
      apiBase: 'https://api.anthropic.com/v1',
      model: 'claude-opus-4-5',
    };
    expect(getPlannerToolId(config)).toBe('anthropic');
  });

  it('falls back to anthropic for api kind with unknown provider', () => {
    const config: PlannerConfig = {
      kind: 'api',
      provider: 'my-custom',
      service: 'my-custom',
      offering: 'payg',
      apiBase: 'http://localhost:9999/v1',
      model: 'my-model',
    };
    expect(getPlannerToolId(config)).toBe('anthropic');
  });

  it('returns shell for shell kind', () => {
    const config: PlannerConfig = { kind: 'shell', command: 'my-planner' };
    expect(getPlannerToolId(config)).toBe('shell');
  });

  it('returns agent (not shell) for agent kind', () => {
    const config: PlannerConfig = { kind: 'agent', command: 'my-agent' };
    expect(getPlannerToolId(config)).toBe('agent');
  });

  it('returns agent-sdk for agent-sdk kind', () => {
    const config: PlannerConfig = { kind: 'agent-sdk' };
    expect(getPlannerToolId(config)).toBe('agent-sdk');
  });
});

describe('getRunnerCatalogDisplayName maps runners to catalog display names', () => {
  it('cli opencode → OpenCode CLI', () => {
    const config: PlannerConfig = { kind: 'cli', tool: 'opencode' };
    expect(getRunnerCatalogDisplayName(config)).toBe('OpenCode CLI');
  });

  it('api anthropic → Anthropic', () => {
    const config: PlannerConfig = {
      kind: 'api',
      provider: 'anthropic',
      service: 'anthropic',
      offering: 'payg',
      apiBase: 'https://api.anthropic.com/v1',
      model: 'claude-opus-4-5',
    };
    expect(getRunnerCatalogDisplayName(config)).toBe('Anthropic');
  });

  it('shell → Custom Shell', () => {
    const config: PlannerConfig = { kind: 'shell', command: 'my-planner' };
    expect(getRunnerCatalogDisplayName(config)).toBe('Custom Shell');
  });

  it('agent → Agent', () => {
    const config: PlannerConfig = { kind: 'agent', command: 'my-agent' };
    expect(getRunnerCatalogDisplayName(config)).toBe('Agent');
  });

  it('agent-sdk → Agent SDK', () => {
    const config: PlannerConfig = { kind: 'agent-sdk' };
    expect(getRunnerCatalogDisplayName(config)).toBe('Agent SDK');
  });
});

describe('getRunnerDisplayName still returns raw lowercase ids', () => {
  it('cli opencode → opencode', () => {
    const config: PlannerConfig = { kind: 'cli', tool: 'opencode' };
    expect(getRunnerDisplayName(config)).toBe('opencode');
  });
});

describe('projectRunnerDiscoveryContext', () => {
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
    const config = anthropicConfig({
      plannerApiKey: 'env:ANTHROPIC_API_KEY',
      implementerApiKey: 'env:ANTHROPIC_API_KEY',
    });
    const planner = projectRunnerDiscoveryContext({ config, role: 'planner' });
    const implementer = projectRunnerDiscoveryContext({ config, role: 'implementer' });

    expect(planner.credentialDomain?.endpointOrigin).toBe('https://api.anthropic.com');
    expect(
      isSameCredentialDomain({
        left: planner.credentialDomain,
        right: implementer.credentialDomain,
      }),
    ).toBe(true);

    const differentEnv = anthropicConfig({
      plannerApiKey: 'env:ANTHROPIC_API_KEY',
      implementerApiKey: 'env:OTHER_ANTHROPIC_KEY',
    });
    expect(
      isSameCredentialDomain({
        left: projectRunnerDiscoveryContext({ config: differentEnv, role: 'planner' })
          .credentialDomain,
        right: projectRunnerDiscoveryContext({ config: differentEnv, role: 'implementer' })
          .credentialDomain,
      }),
    ).toBe(false);

    const inline = anthropicConfig({
      plannerApiKey: 'sk-test-planner',
      implementerApiKey: 'sk-test-implementer',
    });
    const inlinePlanner = projectRunnerDiscoveryContext({ config: inline, role: 'planner' });
    expect(
      isSameCredentialDomain({
        left: inlinePlanner.credentialDomain,
        right: projectRunnerDiscoveryContext({ config: inline, role: 'planner' }).credentialDomain,
      }),
    ).toBe(true);
    expect(
      isSameCredentialDomain({
        left: inlinePlanner.credentialDomain,
        right: projectRunnerDiscoveryContext({ config: inline, role: 'implementer' })
          .credentialDomain,
      }),
    ).toBe(false);

    const sessionConfig: Config = {
      ...config,
      planner: { kind: 'cli', tool: 'claude-code', authChannel: 'session' },
    };
    expect(
      isSameCredentialDomain({
        left: projectRunnerDiscoveryContext({ config: sessionConfig, role: 'planner' })
          .credentialDomain,
        right: projectRunnerDiscoveryContext({ config: sessionConfig, role: 'implementer' })
          .credentialDomain,
      }),
    ).toBe(false);

    const nextGeneration = structuredClone(config);
    expect(
      isSameCredentialDomain({
        left: planner.credentialDomain,
        right: projectRunnerDiscoveryContext({ config: nextGeneration, role: 'planner' })
          .credentialDomain,
      }),
    ).toBe(false);
  });

  it('keeps resolved profile inline credential identity stable and source-specific', () => {
    const rawInlineCredential = 'sk-test-resolved-profile';
    const config = inlineProfileConfig(rawInlineCredential);

    const primary = projectRunnerDiscoveryContext({ config, role: 'implementer' });
    const primaryAgain = projectRunnerDiscoveryContext({ config, role: 'implementer' });

    expect(primary).toMatchObject({ kind: 'api', id: 'anthropic', credentialPresent: true });
    expect(
      isSameCredentialDomain({
        left: primary.credentialDomain,
        right: primaryAgain.credentialDomain,
      }),
    ).toBe(true);
    expect(JSON.stringify(primary)).not.toContain(rawInlineCredential);

    const planner = projectRunnerDiscoveryContext({ config, role: 'planner' });
    expect(
      isSameCredentialDomain({
        left: planner.credentialDomain,
        right: primary.credentialDomain,
      }),
    ).toBe(false);

    config.implementerProfiles.default = 'secondary';
    const secondary = projectRunnerDiscoveryContext({ config, role: 'implementer' });
    expect(primary.configGeneration).toBe(secondary.configGeneration);
    expect(
      isSameCredentialDomain({
        left: primary.credentialDomain,
        right: secondary.credentialDomain,
      }),
    ).toBe(false);

    const nextGeneration = structuredClone(config);
    expect(
      isSameCredentialDomain({
        left: secondary.credentialDomain,
        right: projectRunnerDiscoveryContext({ config: nextGeneration, role: 'implementer' })
          .credentialDomain,
      }),
    ).toBe(false);
  });
});
