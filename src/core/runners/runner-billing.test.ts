import { describe, expect, it } from 'vitest';
import type { PlannerConfig } from '../schemas/planner-config.js';
import { CLI_TOOL_IDS } from './cli-tool-catalog.js';
import { RUNNER_BILLING_POSTURES, billingWord, runnerBillingPosture } from './runner-billing.js';

describe('runner billing posture', () => {
  it('lists the billing postures in canonical presentation order', () => {
    expect(RUNNER_BILLING_POSTURES).toEqual([
      'local',
      'subscription-included',
      'api-metered',
      'provider-dependent',
      'unknown',
    ]);
  });
});

describe('billingWord', () => {
  it('returns one word per resolved posture', () => {
    expect(billingWord('local')).toBe('local');
    expect(billingWord('subscription-included')).toBe('subscription');
    expect(billingWord('api-metered')).toBe('metered');
    expect(billingWord('provider-dependent')).toBe('provider');
  });

  it('gives an unresolved posture no word', () => {
    expect(billingWord('unknown')).toBeUndefined();
  });

  it('yields a non-empty lowercase token for every resolved posture', () => {
    for (const posture of RUNNER_BILLING_POSTURES) {
      if (posture === 'unknown') continue;
      const word = billingWord(posture);
      expect(word).toBeTypeOf('string');
      expect(word).not.toBe('');
      expect(word).toBe(word?.toLowerCase());
    }
  });
});

describe('runnerBillingPosture', () => {
  it('states no posture for any admitted CLI, whose own login decides the method', () => {
    for (const tool of CLI_TOOL_IDS) {
      const planner: PlannerConfig = { kind: 'cli', tool };
      expect(runnerBillingPosture(planner)).toBe('unknown');
    }
  });

  it('bills an API runner on the provider whose connection it opens', () => {
    const local: PlannerConfig = {
      kind: 'api',
      provider: 'ollama',
      service: 'ollama',
      offering: 'local',
      model: 'qwen2.5-coder:7b',
      apiBase: 'http://localhost:11434/v1',
    };
    const custom: PlannerConfig = {
      kind: 'api',
      provider: 'custom-endpoint',
      service: 'custom',
      offering: 'payg',
      model: 'some-model',
      apiBase: 'https://api.example.test/v1',
    };

    expect(runnerBillingPosture(local)).toBe('local');
    expect(runnerBillingPosture(custom)).toBe('unknown');
  });

  it('states no posture for a command that bills whatever it calls', () => {
    const shell: PlannerConfig = { kind: 'shell', command: 'my-planner' };
    const agent: PlannerConfig = { kind: 'agent', command: 'my-agent' };

    expect(runnerBillingPosture(shell)).toBe('unknown');
    expect(runnerBillingPosture(agent)).toBe('unknown');
  });
});
