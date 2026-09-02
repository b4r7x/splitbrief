import { describe, expect, it } from 'vitest';
import { makeNoValidationConfig } from '#testing/helpers/factories/config.js';
import { resolveIntermediateRunner } from './intermediate-runner.js';

describe('resolveIntermediateRunner', () => {
  it('derives the catalog-backed runner used by preparation and execution', () => {
    const config = makeNoValidationConfig({
      implementer: {
        kind: 'api',
        provider: 'ollama',
        model: 'qwen2.5-coder:7b',
        apiBase: 'http://localhost:11434/v1',
        timeout: 42_000,
      },
      escalation: {
        enabled: true,
        intermediateProvider: 'lm-studio',
        intermediateModel: 'deepseek-v4-flash',
      },
    });

    expect(resolveIntermediateRunner(config, { contextLength: 1_000_000 })).toEqual({
      runner: expect.objectContaining({
        kind: 'api',
        provider: 'lm-studio',
        service: 'lm-studio',
        offering: 'local',
        model: 'deepseek-v4-flash',
        contextLength: 1_000_000,
        timeout: 42_000,
      }),
      usedImplementerFallback: false,
    });
  });

  it('uses the current API implementer identity only for an unknown provider', () => {
    const config = makeNoValidationConfig({
      implementer: {
        kind: 'api',
        provider: 'ollama',
        service: 'ollama',
        offering: 'local',
        model: 'qwen',
        apiBase: 'http://localhost:11434/v1',
      },
      escalation: {
        enabled: true,
        intermediateProvider: 'custom-proxy',
        intermediateModel: 'custom-model',
      },
    });

    expect(resolveIntermediateRunner(config)).toEqual({
      runner: expect.objectContaining({
        provider: 'custom-proxy',
        service: 'ollama',
        offering: 'local',
        apiBase: 'http://localhost:11434/v1',
      }),
      usedImplementerFallback: true,
    });
  });

  it('returns null when escalation is disabled or no endpoint identity can be derived', () => {
    expect(
      resolveIntermediateRunner(
        makeNoValidationConfig({
          escalation: {
            enabled: false,
            intermediateProvider: 'lm-studio',
            intermediateModel: 'deepseek-v4-flash',
          },
        }),
      ),
    ).toBeNull();
    expect(
      resolveIntermediateRunner(
        makeNoValidationConfig({
          implementer: { kind: 'cli', tool: 'codex' },
          escalation: {
            enabled: true,
            intermediateProvider: 'custom-proxy',
            intermediateModel: 'custom-model',
          },
        }),
      ),
    ).toBeNull();
  });
});
