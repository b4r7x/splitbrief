import { describe, expect, it } from 'vitest';
import { detectedModelFact, seatEffortChannel, seatSupportsImages } from './capabilities.js';
import type { ProviderDetection } from '../discovery/detection.js';
import type { RunnerConfig } from '../config/accessors/runner-config.js';

function apiRunner(input: { provider: string; model: string }): RunnerConfig {
  return {
    kind: 'api',
    provider: input.provider,
    service: input.provider,
    offering: 'payg',
    apiBase: 'https://example.test/v1',
    model: input.model,
  };
}

const claudeCode = { kind: 'cli', tool: 'claude-code' } satisfies RunnerConfig;
const codex = { kind: 'cli', tool: 'codex' } satisfies RunnerConfig;
const opencode = { kind: 'cli', tool: 'opencode' } satisfies RunnerConfig;
const cursor = { kind: 'cli', tool: 'cursor' } satisfies RunnerConfig;
const shell = { kind: 'shell', command: 'my-planner', model: 'whatever' } satisfies RunnerConfig;
const agent = { kind: 'agent', command: 'my-agent', model: 'whatever' } satisfies RunnerConfig;

describe('seatEffortChannel', () => {
  it('names the channel each CLI seat really uses', () => {
    expect(seatEffortChannel({ runner: claudeCode, role: 'planner' })).toBe('effort-flag');
    expect(seatEffortChannel({ runner: claudeCode, role: 'implementer' })).toBe('effort-flag');
    expect(seatEffortChannel({ runner: opencode, role: 'planner' })).toBe('variant');
    expect(seatEffortChannel({ runner: cursor, role: 'planner' })).toBe('model-id');
    expect(seatEffortChannel({ runner: codex, role: 'planner' })).toBe('none');
  });

  it('gives an api, shell and agent seat no channel', () => {
    expect(
      seatEffortChannel({
        runner: apiRunner({ provider: 'ollama', model: 'qwen3-coder:30b' }),
        role: 'planner',
      }),
    ).toBe('none');
    expect(seatEffortChannel({ runner: shell, role: 'planner' })).toBe('none');
    expect(seatEffortChannel({ runner: agent, role: 'implementer' })).toBe('none');
  });
});

describe('seatSupportsImages', () => {
  it('accepts images on every CLI seat and on no shell seat', () => {
    expect(seatSupportsImages({ runner: claudeCode })).toBe(true);
    expect(seatSupportsImages({ runner: shell })).toBe(false);
  });

  it('takes the detected image modality as the whole answer on an API seat', () => {
    const runner = apiRunner({ provider: 'lm-studio', model: 'llama-3.1-70b' });
    expect(seatSupportsImages({ runner })).toBe(false);
    expect(seatSupportsImages({ runner, detected: { supportsImages: true } })).toBe(true);
    expect(seatSupportsImages({ runner, detected: { supportsImages: false } })).toBe(false);
  });
});

describe('detectedModelFact', () => {
  const providers: readonly ProviderDetection[] = [
    {
      provider: 'lm-studio',
      available: true,
      isLocal: false,
      models: [{ id: 'llama-3.1-70b', supportsImages: true }],
    },
  ];

  it("reads the seat model's own fact out of the detection", () => {
    expect(
      detectedModelFact(providers, apiRunner({ provider: 'lm-studio', model: 'llama-3.1-70b' })),
    ).toEqual({ supportsImages: true });
  });

  it('has no fact for an undetected model or a non-API seat', () => {
    expect(
      detectedModelFact(providers, apiRunner({ provider: 'lm-studio', model: 'llama-3.3-70b' })),
    ).toBeUndefined();
    expect(detectedModelFact(providers, claudeCode)).toBeUndefined();
  });
});
