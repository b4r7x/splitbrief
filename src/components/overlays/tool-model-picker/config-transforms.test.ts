import { describe, it, expect } from 'vitest';
import type { Config } from '../../../types.js';
import { commitCustomCommand } from './config-transforms.js';

function makeBaseConfig(): Config {
  return {
    version: 2,
    planner: {
      kind: 'shell',
      command: 'old-command',
    },
    implementer: {
      kind: 'api',
      provider: 'ollama',
      model: 'llama3',
      apiBase: 'http://localhost:11434/v1',
      contextLength: 8192,
      temperature: 0.3,
    },
    validation: { typecheck: true, lint: true, test: true, testCommand: 'npm test' },
    workflow: { autoApproveSpec: false, autoApprovePlan: false, maxRetries: 3, commitStrategy: 'none' },
  };
}

describe('commitCustomCommand', () => {
  it('preserves kind: shell for shell selection', () => {
    const config = makeBaseConfig();
    const updated = commitCustomCommand(config, 'planner', 'my-shell-tool --flag', 'shell');
    expect(updated.planner.kind).toBe('shell');
    if (updated.planner.kind === 'shell') {
      expect(updated.planner.command).toBe('my-shell-tool --flag');
    }
  });

  it('preserves kind: agent for agent selection', () => {
    const config = makeBaseConfig();
    const updated = commitCustomCommand(config, 'planner', 'my-agent-tool --flag', 'agent');
    expect(updated.planner.kind).toBe('agent');
    if (updated.planner.kind === 'agent') {
      expect(updated.planner.command).toBe('my-agent-tool --flag');
    }
  });

  it('preserves implementer kind: shell for shell implementer selection', () => {
    const config: Config = {
      ...makeBaseConfig(),
      implementer: {
        kind: 'shell',
        command: 'old-impl',
        model: 'llama3',
      },
    };
    const updated = commitCustomCommand(config, 'implementer', 'new-impl-cmd', 'shell');
    expect(updated.implementer.kind).toBe('shell');
  });

  it('preserves implementer kind: agent for agent implementer selection', () => {
    const config: Config = {
      ...makeBaseConfig(),
      implementer: {
        kind: 'agent',
        command: 'old-impl',
        model: 'llama3',
      },
    };
    const updated = commitCustomCommand(config, 'implementer', 'new-agent-impl', 'agent');
    expect(updated.implementer.kind).toBe('agent');
  });
});
