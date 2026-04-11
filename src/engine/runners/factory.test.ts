import { describe, it, expect, vi } from 'vitest';
import { createPlanner, createImplementer } from './factory.js';
import { makeConfig, makeTask } from '#testing/helpers/fixtures.js';

const PLANNER_INTERFACE_METHODS = ['plan', 'quickPlan', 'escalateHint', 'escalateFull', 'regenerate', 'review', 'isAvailable', 'getVersion'] as const;
const IMPLEMENTER_INTERFACE_METHODS = ['implement', 'retry', 'isAvailable', 'getVersion'] as const;

function assertPlannerInterface(planner: ReturnType<typeof createPlanner>) {
  for (const method of PLANNER_INTERFACE_METHODS) {
    expect(planner[method]).toBeInstanceOf(Function);
  }
}

function assertImplementerInterface(impl: ReturnType<typeof createImplementer>) {
  for (const method of IMPLEMENTER_INTERFACE_METHODS) {
    expect(impl[method]).toBeInstanceOf(Function);
  }
}

describe('createPlanner factory', () => {
  it('dispatches planner.kind: "agent" to createAgentPlanner', () => {
    const config = makeConfig({ planner: { kind: 'agent', command: 'echo' } });
    const planner = createPlanner(config);
    assertPlannerInterface(planner);
  });

  it('dispatches planner.kind: "shell" to createShellPlanner', () => {
    const config = makeConfig({ planner: { kind: 'shell', command: 'echo' } });
    const planner = createPlanner(config);
    assertPlannerInterface(planner);
  });

  it('dispatches planner.kind: "api" to createApiPlanner', () => {
    const config = makeConfig({ planner: { kind: 'api', provider: 'anthropic', apiBase: 'https://api.anthropic.com/v1', model: 'claude-opus-4-5' } });
    const planner = createPlanner(config);
    assertPlannerInterface(planner);
  });

  it('dispatches planner.kind: "agent-sdk" to createAgentSdkPlanner', () => {
    const config = makeConfig({ planner: { kind: 'agent-sdk' } });
    const planner = createPlanner(config);
    assertPlannerInterface(planner);
  });

  describe('planner.kind: "cli"', () => {
    it('dispatches cli/claude-code to createClaudeCodePlanner (supportsHintEscalation: false)', async () => {
      const config = makeConfig({ planner: { kind: 'cli', tool: 'claude-code' } });
      const planner = createPlanner(config);
      assertPlannerInterface(planner);

      // Claude-code planner has supportsHintEscalation: false — escalateHint returns success: false without invoking
      const task = makeTask();
      const callbacks = { onOutput: vi.fn() };
      const result = await planner.escalateHint(task, 'error', '/tmp', callbacks);
      // claude-code sets supportsHintEscalation: false → always returns success: false, empty output
      expect(result.success).toBe(false);
      expect(result.output).toBe('');
      // onOutput should NOT have been called (no invoke happened)
      expect(callbacks.onOutput).not.toHaveBeenCalled();
    });

    it('dispatches cli/aider to createCliPlanner (supportsHintEscalation: true)', async () => {
      const config = makeConfig({ planner: { kind: 'cli', tool: 'aider' } });
      const planner = createPlanner(config);
      assertPlannerInterface(planner);

      // Generic CLI planner DOES support hint escalation — escalateHint will attempt to invoke
      // We only verify it exists and the interface is correct (full invocation would require the CLI tool)
      expect(planner.escalateHint).toBeInstanceOf(Function);
    });
  });
});

describe('createImplementer factory', () => {
  it('dispatches implementer.kind: "api" to createApiImplementer', () => {
    const config = makeConfig({
      planner: { kind: 'shell', command: 'echo' },
      implementer: { kind: 'api', provider: 'ollama', model: 'llama3', apiBase: 'http://localhost:11434/v1' },
    });
    const impl = createImplementer(config);
    assertImplementerInterface(impl);
  });

  it('dispatches implementer.kind: "shell" to createShellImplementer', () => {
    const config = makeConfig({
      planner: { kind: 'shell', command: 'echo' },
      implementer: { kind: 'shell', command: 'echo', model: 'llama3' },
    });
    const impl = createImplementer(config);
    assertImplementerInterface(impl);
  });

  it('dispatches implementer.kind: "agent" to createAgentImplementer', () => {
    const config = makeConfig({
      planner: { kind: 'shell', command: 'echo' },
      implementer: { kind: 'agent', command: 'echo', model: 'llama3' },
    });
    const impl = createImplementer(config);
    assertImplementerInterface(impl);
  });

  it('dispatches implementer.kind: "agent-sdk" to createAgentSdkImplementer', () => {
    const config = makeConfig({
      planner: { kind: 'shell', command: 'echo' },
      implementer: { kind: 'agent-sdk', model: 'claude-opus-4-5' },
    });
    const impl = createImplementer(config);
    assertImplementerInterface(impl);
  });

  it('dispatches implementer.kind: "cli" to createCliImplementer', () => {
    const config = makeConfig({
      planner: { kind: 'shell', command: 'echo' },
      implementer: { kind: 'cli', tool: 'aider', model: 'claude-opus-4-5' },
    });
    const impl = createImplementer(config);
    assertImplementerInterface(impl);
  });
});
