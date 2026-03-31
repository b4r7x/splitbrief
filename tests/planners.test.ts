import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createPlanner } from '../src/engine/planners/factory.js';
import type { Config } from '../src/types.js';

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
    assert.equal(backend.name, 'claude-code');
  });

  it('codex returns a backend with name "codex"', async () => {
    const backend = await createPlanner(makeConfig('codex'));
    assert.equal(backend.name, 'codex');
  });

  it('opencode returns a backend with name "opencode"', async () => {
    const backend = await createPlanner(makeConfig('opencode'));
    assert.equal(backend.name, 'opencode');
  });

  it('aider returns a backend with name "aider"', async () => {
    const backend = await createPlanner(makeConfig('aider'));
    assert.equal(backend.name, 'aider');
  });

  it('agent-sdk returns a backend with name "agent-sdk"', async () => {
    const backend = await createPlanner(makeConfig('agent-sdk'));
    assert.equal(backend.name, 'agent-sdk');
  });

  it('shell returns a backend with name starting with "shell:"', async () => {
    const backend = await createPlanner(makeConfig('shell', { command: 'echo' }));
    assert.ok(backend.name.startsWith('shell:'));
  });

  it('shell backend has all required functions', async () => {
    const backend = await createPlanner(makeConfig('shell', { command: 'echo' }));
    assert.equal(typeof backend.plan, 'function');
    assert.equal(typeof backend.escalateHint, 'function');
    assert.equal(typeof backend.escalateFull, 'function');
    assert.equal(typeof backend.isAvailable, 'function');
    assert.equal(typeof backend.getPricing, 'function');
  });

  it('unknown tool throws error with helpful message', async () => {
    await assert.rejects(
      () => createPlanner(makeConfig('unknown-tool' as any)),
      (err: Error) => {
        assert.ok(err.message.includes('Unknown planner tool: unknown-tool'));
        assert.ok(err.message.includes('Supported:'));
        return true;
      },
    );
  });

  for (const tool of KNOWN_TOOLS) {
    it(`${tool} backend has all required functions`, async () => {
      const backend = await createPlanner(makeConfig(tool));
      assert.equal(typeof backend.plan, 'function');
      assert.equal(typeof backend.escalateHint, 'function');
      assert.equal(typeof backend.escalateFull, 'function');
      assert.equal(typeof backend.isAvailable, 'function');
      assert.equal(typeof backend.getPricing, 'function');
    });

    it(`${tool} getPricing() returns non-null PricingInfo`, async () => {
      const backend = await createPlanner(makeConfig(tool));
      const pricing = backend.getPricing();
      assert.ok(pricing !== null && pricing !== undefined);
      assert.equal(typeof pricing.inputPer1M, 'number');
      assert.equal(typeof pricing.outputPer1M, 'number');
      assert.equal(typeof pricing.isLocal, 'boolean');
      assert.equal(typeof pricing.name, 'string');
    });
  }
});
