import { describe, expect, it } from 'vitest';
import { crossLabVerdict, resolveLab } from './labs.js';
import type { RunnerConfig } from '../config/accessors/runner-config.js';

const claudeCode = { kind: 'cli', tool: 'claude-code' } satisfies RunnerConfig;
const codex = { kind: 'cli', tool: 'codex' } satisfies RunnerConfig;
const opencode = { kind: 'cli', tool: 'opencode' } satisfies RunnerConfig;

function apiRunner(input: { provider: string; service: string; model: string }): RunnerConfig {
  return {
    kind: 'api',
    provider: input.provider,
    service: input.service,
    offering: 'payg',
    apiBase: 'https://example.test/v1',
    model: input.model,
  };
}

const anthropicApi = apiRunner({
  provider: 'anthropic',
  service: 'anthropic',
  model: 'claude-sonnet-4-5',
});
const openrouter = apiRunner({
  provider: 'openrouter',
  service: 'openrouter',
  model: 'anthropic/claude-sonnet-4-5',
});
const agentSdk = { kind: 'agent-sdk' } satisfies RunnerConfig;
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

  it('names Anthropic as the lab behind the agent SDK', () => {
    expect(resolveLab(agentSdk)).toEqual({ kind: 'known', lab: 'anthropic' });
  });

  it("names the lab behind an API provider's service", () => {
    expect(resolveLab(anthropicApi)).toEqual({ kind: 'known', lab: 'anthropic' });
  });

  it('leaves an API seat undetermined when the model names another vendor', () => {
    expect(
      resolveLab(apiRunner({ provider: 'anthropic', service: 'anthropic', model: 'openai/gpt-5' })),
    ).toEqual({
      kind: 'undetermined',
    });
  });

  it('leaves routers, custom providers and command runners undetermined', () => {
    expect(resolveLab(openrouter)).toEqual({ kind: 'undetermined' });
    expect(
      resolveLab(
        apiRunner({ provider: 'my-gateway', service: 'my-gateway', model: 'anthropic/claude' }),
      ),
    ).toEqual({
      kind: 'undetermined',
    });
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
    expect(
      crossLabVerdict({ build: resolveLab(claudeCode), review: resolveLab(anthropicApi) }),
    ).toBe('same-lab');
  });

  it('reports cross-lab for an agent SDK reviewer against another lab', () => {
    expect(crossLabVerdict({ build: resolveLab(codex), review: resolveLab(agentSdk) })).toBe(
      'cross-lab',
    );
  });

  it('reports nothing when either seat is undetermined', () => {
    expect(
      crossLabVerdict({ build: resolveLab(claudeCode), review: resolveLab(openrouter) }),
    ).toBeUndefined();
    expect(
      crossLabVerdict({ build: resolveLab(shell), review: resolveLab(codex) }),
    ).toBeUndefined();
  });
});
