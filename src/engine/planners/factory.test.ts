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
      commitPerTask: true,
    },
  };
}

const KNOWN_TOOLS = ['claude-code', 'codex', 'opencode', 'aider', 'agent-sdk'] as const;

describe('createPlanner', () => {
  it('claude-code returns a backend with name "claude-code"', async () => {
    const backend = await createPlanner(makeConfig('claude-code'));
    expect(backend.name).toBe('claude-code');
  });

  it('codex returns a backend with name "codex"', async () => {
    const backend = await createPlanner(makeConfig('codex'));
    expect(backend.name).toBe('codex');
  });

  it('opencode returns a backend with name "opencode"', async () => {
    const backend = await createPlanner(makeConfig('opencode'));
    expect(backend.name).toBe('opencode');
  });

  it('aider returns a backend with name "aider"', async () => {
    const backend = await createPlanner(makeConfig('aider'));
    expect(backend.name).toBe('aider');
  });

  it('agent-sdk returns a backend with name "agent-sdk"', async () => {
    const backend = await createPlanner(makeConfig('agent-sdk'));
    expect(backend.name).toBe('agent-sdk');
  });

  it('shell returns a backend with name starting with "shell:"', async () => {
    const backend = await createPlanner(makeConfig('shell', { command: 'echo' }));
    expect(backend.name.startsWith('shell:')).toBeTruthy();
  });

  it('shell backend has all required functions', async () => {
    const backend = await createPlanner(makeConfig('shell', { command: 'echo' }));
    expect(typeof backend.plan).toBe('function');
    expect(typeof backend.escalateHint).toBe('function');
    expect(typeof backend.escalateFull).toBe('function');
    expect(typeof backend.isAvailable).toBe('function');
    expect(typeof backend.getPricing).toBe('function');
  });

  it('unknown tool throws error with helpful message', async () => {
    await expect(
      createPlanner(makeConfig('unknown-tool' as any)),
    ).rejects.toThrow(/Unknown planner tool: unknown-tool/);
  });

  for (const tool of KNOWN_TOOLS) {
    it(`${tool} backend has all required functions`, async () => {
      const backend = await createPlanner(makeConfig(tool));
      expect(typeof backend.plan).toBe('function');
      expect(typeof backend.escalateHint).toBe('function');
      expect(typeof backend.escalateFull).toBe('function');
      expect(typeof backend.isAvailable).toBe('function');
      expect(typeof backend.getPricing).toBe('function');
    });

    it(`${tool} getPricing() returns non-null PricingInfo`, async () => {
      const backend = await createPlanner(makeConfig(tool));
      const pricing = backend.getPricing();
      expect(pricing).toBeTruthy();
      expect(typeof pricing.inputPer1M).toBe('number');
      expect(typeof pricing.outputPer1M).toBe('number');
      expect(typeof pricing.isLocal).toBe('boolean');
      expect(typeof pricing.name).toBe('string');
    });
  }
});
