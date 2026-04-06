import { describe, it, expect } from 'vitest';
import { createPlanner } from './factory.js';
import type { Config } from '../../types.js';

function makeConfig(tool: string, extra?: Partial<Config['planner']>): Config {
  return {
    planner: { tool: tool as Config['planner']['tool'], ...extra },
    implementer: {
      provider: 'ollama',
      model: 'test',
      apiBase: '',
      contextLength: 8192,
      temperature: 0.3,
    },
    validation: {
      typecheck: true,
      lint: true,
      test: true,
      testCommand: 'npm test',
    },
    workflow: {
      autoApproveSpec: false,
      autoApprovePlan: false,
      maxRetries: 3,
      commitStrategy: 'none',
    },
  };
}

const KNOWN_TOOLS = ['claude-code', 'codex', 'opencode', 'aider', 'agent-sdk', 'anthropic', 'openrouter'] as const;

describe('createPlanner', () => {
  it('claude-code returns a backend with name "claude-code"', async () => {
    const planner = await createPlanner(makeConfig('claude-code'));
    expect(planner.name).toBe('claude-code');
  });

  it('codex returns a backend with name "codex"', async () => {
    const planner = await createPlanner(makeConfig('codex'));
    expect(planner.name).toBe('codex');
  });

  it('opencode returns a backend with name "opencode"', async () => {
    const planner = await createPlanner(makeConfig('opencode'));
    expect(planner.name).toBe('opencode');
  });

  it('aider returns a backend with name "aider"', async () => {
    const planner = await createPlanner(makeConfig('aider'));
    expect(planner.name).toBe('aider');
  });

  it('agent-sdk returns a backend with name "agent-sdk"', async () => {
    const planner = await createPlanner(makeConfig('agent-sdk'));
    expect(planner.name).toBe('agent-sdk');
  });

  it('shell returns a backend with name starting with "shell:"', async () => {
    const planner = await createPlanner(makeConfig('shell', { command: 'echo' }));
    expect(planner.name.startsWith('shell:')).toBeTruthy();
  });

  it('shell backend has all required functions', async () => {
    const planner = await createPlanner(makeConfig('shell', { command: 'echo' }));
    expect(typeof planner.plan).toBe('function');
    expect(typeof planner.escalateHint).toBe('function');
    expect(typeof planner.escalateFull).toBe('function');
    expect(typeof planner.isAvailable).toBe('function');
    expect(typeof planner.getPricing).toBe('function');
  });

  it('anthropic routes to API planner with provider set', async () => {
    const planner = await createPlanner(makeConfig('anthropic'));
    expect(planner.name).toBe('api:anthropic');
  });

  it('openrouter routes to API planner with provider set', async () => {
    const planner = await createPlanner(makeConfig('openrouter'));
    expect(planner.name).toBe('api:openrouter');
  });

  it('planner.provider without explicit tool routes to API planner', async () => {
    const config = makeConfig('claude-code', { provider: 'deepseek', model: 'deepseek-chat', apiBase: 'https://api.deepseek.com/v1' });
    const planner = await createPlanner(config);
    expect(planner.name).toBe('api:deepseek');
  });

  it('unknown tool throws error with helpful message', async () => {
    await expect(
      createPlanner(makeConfig('unknown-tool' as any)),
    ).rejects.toThrow(/Unknown planner tool: unknown-tool/);
  });

  for (const tool of KNOWN_TOOLS) {
    it(`${tool} backend has all required functions`, async () => {
      const planner = await createPlanner(makeConfig(tool));
      expect(typeof planner.plan).toBe('function');
      expect(typeof planner.escalateHint).toBe('function');
      expect(typeof planner.escalateFull).toBe('function');
      expect(typeof planner.isAvailable).toBe('function');
      expect(typeof planner.getVersion).toBe('function');
      expect(typeof planner.getPricing).toBe('function');
    });

    it(`${tool} getPricing() returns non-null PricingInfo`, async () => {
      const planner = await createPlanner(makeConfig(tool));
      const pricing = planner.getPricing();
      expect(pricing).toBeTruthy();
      expect(typeof pricing.inputPer1M).toBe('number');
      expect(typeof pricing.outputPer1M).toBe('number');
      expect(typeof pricing.isLocal).toBe('boolean');
      expect(typeof pricing.name).toBe('string');
    });
  }
});
