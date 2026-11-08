import { describe, expect, it } from 'vitest';
import { seatConfiguredEffort, seatEffortChannel, seatSupportsImages } from './capabilities.js';
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
    expect(seatEffortChannel({ runner: antigravity, role: 'planner' })).toBe('model-id');
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

it('does not seed a separate effort draft for an Antigravity model-id seat', () => {
  const runner = {
    ...antigravity,
    model: 'gemini-3.8-flash-high',
    effort: 'low',
  } as const;
  for (const role of ['planner', 'implementer', 'reviewer'] as const) {
    expect(seatConfiguredEffort({ runner, role })).toBeNull();
  }
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

  // opencode 2.0.14 lists `opencode-go/qwen3.7-max` with input ["text"]; the tool sends images,
  // the model cannot read them.
  it("takes the model's own image fact on a CLI tool with an image channel", () => {
    const qwen = { ...opencode, model: 'opencode-go/qwen3.7-max' } satisfies RunnerConfig;
    const kiloText = {
      ...kiloCode,
      model: 'kilo/cohere/north-mini-code:free',
    } satisfies RunnerConfig;

    expect(seatSupportsImages({ runner: qwen, detected: { supportsImages: false } })).toBe(false);
    expect(seatSupportsImages({ runner: kiloText, detected: { supportsImages: false } })).toBe(
      false,
    );
    expect(seatSupportsImages({ runner: qwen, detected: { supportsImages: true } })).toBe(true);
    expect(seatSupportsImages({ runner: qwen, detected: {} })).toBe(true);
    expect(seatSupportsImages({ runner: qwen })).toBe(true);
  });

  it('keeps a CLI tool with no image channel at false whatever the model reads', () => {
    for (const runner of [commandCode, cursor, antigravity]) {
      expect(seatSupportsImages({ runner, detected: { supportsImages: true } })).toBe(false);
    }
  });

  it('takes the detected image modality as the whole answer on an API seat', () => {
    const runner = apiRunner({ provider: 'lm-studio', model: 'llama-3.1-70b' });
    expect(seatSupportsImages({ runner })).toBe(false);
    expect(seatSupportsImages({ runner, detected: { supportsImages: true } })).toBe(true);
    expect(seatSupportsImages({ runner, detected: { supportsImages: false } })).toBe(false);
  });
});
