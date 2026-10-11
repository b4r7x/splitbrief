import { describe, expect, it } from 'vitest';
import {
  detectedModelFact,
  plannerSupportsImages,
  seatEffortChannel,
  seatSupportsImages,
} from './capabilities.js';
import { makeConfig } from '#testing/helpers/factories/config.js';
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
const kiloCode = { kind: 'cli', tool: 'kilo-code' } satisfies RunnerConfig;
const copilot = { kind: 'cli', tool: 'copilot' } satisfies RunnerConfig;
const cursor = { kind: 'cli', tool: 'cursor' } satisfies RunnerConfig;
const commandCode = { kind: 'cli', tool: 'command-code' } satisfies RunnerConfig;
const antigravity = { kind: 'cli', tool: 'antigravity' } satisfies RunnerConfig;
const shell = { kind: 'shell', command: 'my-planner', model: 'whatever' } satisfies RunnerConfig;
const agent = { kind: 'agent', command: 'my-agent', model: 'whatever' } satisfies RunnerConfig;

describe('seatEffortChannel', () => {
  it('names the channel each CLI seat really uses', () => {
    expect(seatEffortChannel({ runner: claudeCode, role: 'planner' })).toBe('effort-flag');
    expect(seatEffortChannel({ runner: claudeCode, role: 'implementer' })).toBe('effort-flag');
    expect(seatEffortChannel({ runner: opencode, role: 'planner' })).toBe('variant');
    expect(seatEffortChannel({ runner: cursor, role: 'planner' })).toBe('model-id');
    expect(seatEffortChannel({ runner: codex, role: 'planner' })).toBe('effort-flag');
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
  it('reads the image channel each CLI tool declares', () => {
    expect(seatSupportsImages({ runner: claudeCode })).toBe(true);
    expect(seatSupportsImages({ runner: codex })).toBe(true);
    expect(seatSupportsImages({ runner: opencode })).toBe(true);
    expect(seatSupportsImages({ runner: kiloCode })).toBe(true);
    expect(seatSupportsImages({ runner: copilot })).toBe(true);
    expect(seatSupportsImages({ runner: cursor })).toBe(false);
    expect(seatSupportsImages({ runner: commandCode })).toBe(false);
    expect(seatSupportsImages({ runner: antigravity })).toBe(false);
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

describe('plannerSupportsImages', () => {
  it('uses the planner tool channel even before detection', () => {
    expect(plannerSupportsImages(null, [])).toBe(false);
    for (const [planner, supportsImages] of [
      [claudeCode, true],
      [codex, true],
      [opencode, true],
      [kiloCode, true],
      [copilot, true],
      [cursor, false],
      [commandCode, false],
      [antigravity, false],
      [shell, false],
      [agent, false],
    ] as const) {
      expect(plannerSupportsImages(makeConfig({ planner }), [])).toBe(supportsImages);
    }
  });

  it('uses the API planner model fact from its own provider', () => {
    const config = makeConfig({
      planner: {
        kind: 'api',
        provider: 'lm-studio',
        apiBase: 'http://localhost:1234/v1',
        model: 'vision',
      },
    });
    const otherProvider: ProviderDetection = {
      provider: 'ollama',
      available: true,
      isLocal: true,
      models: [{ id: 'vision', supportsImages: true }],
    };
    expect(plannerSupportsImages(config, [otherProvider])).toBe(false);
    const provider: ProviderDetection = { ...otherProvider, provider: 'lm-studio' };
    expect(plannerSupportsImages(config, [provider])).toBe(true);
    expect(plannerSupportsImages(config, [{ ...provider, models: [] }])).toBe(false);
    expect(
      plannerSupportsImages(config, [
        { ...provider, models: [{ id: 'vision', supportsImages: false }] },
      ]),
    ).toBe(false);
  });
});
