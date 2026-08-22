import { describe, expect, it } from 'vitest';
import { makeConfig } from './config.js';

describe('makeConfig', () => {
  it('creates the default local API implementer with canonical identity', () => {
    expect(makeConfig().implementer).toMatchObject({
      kind: 'api',
      provider: 'ollama',
      service: 'ollama',
      offering: 'local',
    });
  });

  it('adds catalog identity to API runner and profile fixtures', () => {
    const config = makeConfig({
      planner: {
        kind: 'api',
        provider: 'anthropic',
        model: 'claude-sonnet-4-6',
        apiBase: 'https://api.anthropic.com/v1',
      },
      implementer: {
        kind: 'api',
        provider: 'openrouter',
        model: 'qwen/qwen3-coder',
        apiBase: 'https://openrouter.ai/api/v1',
      },
      implementerProfiles: {
        profiles: {
          local: {
            kind: 'api',
            provider: 'ollama',
            model: 'qwen2.5-coder:7b',
            apiBase: 'http://localhost:11434/v1',
          },
        },
      },
    });

    expect(config.planner).toMatchObject({ service: 'anthropic', offering: 'payg' });
    expect(config.implementer).toMatchObject({ service: 'openrouter', offering: 'payg' });
    expect(config.implementerProfiles?.profiles.local).toMatchObject({
      service: 'ollama',
      offering: 'local',
    });
  });

  it('carries a reviewer override into the parsed config, and none when unset', () => {
    const config = makeConfig({
      reviewer: {
        kind: 'api',
        provider: 'anthropic',
        model: 'claude-sonnet-4-6',
        apiBase: 'https://api.anthropic.com/v1',
      },
    });

    expect(config.reviewer).toMatchObject({
      kind: 'api',
      provider: 'anthropic',
      service: 'anthropic',
      offering: 'payg',
    });
    expect(makeConfig().reviewer).toBeUndefined();
  });

  it('keeps explicit custom-provider identity', () => {
    const config = makeConfig({
      implementer: {
        kind: 'api',
        provider: 'company-gateway',
        service: 'company-ai',
        offering: 'free-quota',
        model: 'company-coder',
        apiBase: 'https://ai.example.test/v1',
      },
    });

    expect(config.implementer).toMatchObject({
      provider: 'company-gateway',
      service: 'company-ai',
      offering: 'free-quota',
    });
  });
});
