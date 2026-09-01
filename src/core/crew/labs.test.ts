import { describe, expect, it } from 'vitest';
import { crossLabVerdict, resolveLab } from './labs.js';
import type { RunnerConfig } from '../config/accessors/runner-config.js';

const claudeCode = { kind: 'cli', tool: 'claude-code' } satisfies RunnerConfig;
const codex = { kind: 'cli', tool: 'codex' } satisfies RunnerConfig;
const opencode = { kind: 'cli', tool: 'opencode' } satisfies RunnerConfig;

function apiRunner(input: {
  provider: string;
  service: string;
  model: string;
  offering?: 'local' | 'payg';
  apiBase?: string;
}): RunnerConfig {
  return {
    kind: 'api',
    provider: input.provider,
    service: input.service,
    offering: input.offering ?? 'payg',
    apiBase: input.apiBase ?? 'https://api.example.test/v1',
    model: input.model,
  };
}

const ollama = apiRunner({
  provider: 'ollama',
  service: 'ollama',
  model: 'llama3.1',
  offering: 'local',
  apiBase: 'http://localhost:11434/v1',
});
const gateway = apiRunner({
  provider: 'my-gateway',
  service: 'my-gateway',
  model: 'anthropic/claude',
});
const shell = {
  kind: 'shell',
  command: 'my-reviewer',
  model: 'whatever',
} satisfies RunnerConfig;

describe('resolveLab', () => {
  it('names the lab of a CLI tool that fronts exactly one', () => {
    expect(resolveLab(claudeCode)).toEqual({ kind: 'known', lab: 'anthropic' });
    expect(resolveLab(codex)).toEqual({ kind: 'known', lab: 'openai' });
  });

  it('leaves a CLI tool that runs any provider undetermined', () => {
    expect(resolveLab(opencode)).toEqual({ kind: 'undetermined' });
  });

  it('leaves an API seat undetermined when no admitted provider fronts a lab', () => {
    expect(resolveLab(ollama)).toEqual({ kind: 'undetermined' });
    expect(
      resolveLab(
        apiRunner({
          provider: 'lm-studio',
          service: 'lm-studio',
          model: 'qwen2.5-coder:7b',
          offering: 'local',
          apiBase: 'http://localhost:1234/v1',
        }),
      ),
    ).toEqual({ kind: 'undetermined' });
  });

  it('leaves custom providers and command runners undetermined', () => {
    expect(resolveLab(gateway)).toEqual({ kind: 'undetermined' });
    expect(resolveLab(shell)).toEqual({ kind: 'undetermined' });
  });
});

describe('crossLabVerdict', () => {
  it('reports cross-lab when the two seats resolve to different labs', () => {
    expect(crossLabVerdict({ build: resolveLab(claudeCode), review: resolveLab(codex) })).toBe(
      'cross-lab',
    );
  });

  it('reports same-lab when both seats resolve to the same lab', () => {
    expect(crossLabVerdict({ build: resolveLab(claudeCode), review: resolveLab(claudeCode) })).toBe(
      'same-lab',
    );
  });

  it('reports nothing when either seat is undetermined', () => {
    expect(
      crossLabVerdict({ build: resolveLab(claudeCode), review: resolveLab(ollama) }),
    ).toBeUndefined();
    expect(
      crossLabVerdict({ build: resolveLab(shell), review: resolveLab(codex) }),
    ).toBeUndefined();
  });
});
