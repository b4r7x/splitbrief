import { describe, expect, it } from 'vitest';
import {
  detectedModelFact,
  modelSupportsEffort,
  modelSupportsImages,
  seatSupportsEffort,
  seatSupportsImages,
} from './capabilities.js';
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
const agentSdk = { kind: 'agent-sdk' } satisfies RunnerConfig;
const shell = { kind: 'shell', command: 'my-planner', model: 'whatever' } satisfies RunnerConfig;

describe('modelSupportsEffort', () => {
  it.each([
    ['anthropic', 'claude-sonnet-4', true],
    ['anthropic', 'claude-opus-4-1', true],
    ['anthropic', 'claude-3-haiku', false],
    ['openai', 'gpt-5', true],
    ['openai', 'o1-mini', true],
    ['openai', 'gpt-4o', false],
    ['openrouter', 'openai/gpt-5', true],
    ['openrouter', 'anthropic/claude-3.5-sonnet', false],
    ['deepseek', 'deepseek-reasoner', true],
    ['deepseek', 'deepseek-chat', false],
    ['ollama', 'qwen2.5', false],
    ['openai', undefined, false],
  ] as const)('%s / %s => %s', (provider, model, expected) => {
    expect(modelSupportsEffort(provider, model)).toBe(expected);
  });
});

describe('modelSupportsImages', () => {
  it.each([
    ['openai', 'gpt-4o', true],
    ['anthropic', 'claude-3-5-sonnet', true],
    ['openrouter', 'google/gemini-2.5-pro-preview', true],
    ['groq', 'llama-3.1-70b', false],
  ] as const)('%s / %s => %s', (provider, model, expected) => {
    expect(modelSupportsImages({ provider, model })).toBe(expected);
  });

  it('takes the detected modality fact over the model-name guess', () => {
    expect(
      modelSupportsImages({
        provider: 'groq',
        model: 'llama-3.1-70b',
        detected: { supportsImages: true },
      }),
    ).toBe(true);
    expect(
      modelSupportsImages({
        provider: 'openai',
        model: 'gpt-4o',
        detected: { supportsImages: false },
      }),
    ).toBe(false);
  });
});

describe('seatSupportsEffort', () => {
  it('offers effort on every Claude Code seat and never on Codex', () => {
    expect(seatSupportsEffort({ runner: claudeCode, role: 'planner' })).toBe(true);
    expect(seatSupportsEffort({ runner: claudeCode, role: 'reviewer' })).toBe(true);
    expect(seatSupportsEffort({ runner: claudeCode, role: 'implementer' })).toBe(true);
    expect(seatSupportsEffort({ runner: codex, role: 'planner' })).toBe(false);
    expect(seatSupportsEffort({ runner: codex, role: 'implementer' })).toBe(false);
  });

  it('refuses effort for a CLI tool with no effort flag', () => {
    expect(seatSupportsEffort({ runner: codex, role: 'planner' })).toBe(false);
  });

  it('reads an API seat through its model', () => {
    expect(
      seatSupportsEffort({
        runner: apiRunner({ provider: 'deepseek', model: 'deepseek-chat' }),
        role: 'planner',
      }),
    ).toBe(false);
    expect(
      seatSupportsEffort({
        runner: apiRunner({ provider: 'deepseek', model: 'deepseek-reasoner' }),
        role: 'planner',
      }),
    ).toBe(true);
  });

  it('offers effort on the agent SDK and never on a shell seat', () => {
    expect(seatSupportsEffort({ runner: agentSdk, role: 'planner' })).toBe(true);
    expect(seatSupportsEffort({ runner: shell, role: 'planner' })).toBe(false);
  });
});

describe('seatSupportsImages', () => {
  it('accepts images on every CLI and agent-SDK seat and on no shell seat', () => {
    expect(seatSupportsImages({ runner: claudeCode })).toBe(true);
    expect(seatSupportsImages({ runner: agentSdk })).toBe(true);
    expect(seatSupportsImages({ runner: shell })).toBe(false);
  });

  it('lets a detected image modality override a model-name miss on an API seat', () => {
    const runner = apiRunner({ provider: 'groq', model: 'llama-3.1-70b' });
    expect(seatSupportsImages({ runner })).toBe(false);
    expect(seatSupportsImages({ runner, detected: { supportsImages: true } })).toBe(true);
  });
});

describe('detectedModelFact', () => {
  const providers: readonly ProviderDetection[] = [
    {
      provider: 'groq',
      available: true,
      isLocal: false,
      models: [{ id: 'llama-3.1-70b', supportsImages: true }],
    },
  ];

  it("reads the seat model's own fact out of the detection", () => {
    expect(
      detectedModelFact(providers, apiRunner({ provider: 'groq', model: 'llama-3.1-70b' })),
    ).toEqual({ supportsImages: true });
  });

  it('has no fact for an undetected model or a non-API seat', () => {
    expect(
      detectedModelFact(providers, apiRunner({ provider: 'groq', model: 'llama-3.3-70b' })),
    ).toBeUndefined();
    expect(detectedModelFact(providers, claudeCode)).toBeUndefined();
  });
});
