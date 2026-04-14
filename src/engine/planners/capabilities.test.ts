import { describe, it, expect } from 'vitest';
import { createClaudeCodePlanner } from './claude-code.js';
import { createApiPlanner } from './api.js';
import { createShellPlanner } from './shell.js';
import { createAgentPlanner } from './agent.js';
import { createCliPlanner } from './cli.js';
import { makeConfig } from '#testing/helpers/fixtures.js';
import { PlannerConfigSchema } from '../../core/types/schemas/planner-config.js';

describe('capability matrix — per-backend declared values (FR-003)', () => {
  it('claude-code: conv=true, hint=false, resume=true, inject=true', () => {
    const planner = createClaudeCodePlanner();
    expect(planner.capabilities).toEqual({
      supportsConversationalPlanning: true,
      supportsHintEscalation: false,
      supportsSessionResume: true,
      supportsMidStreamInjection: true,
    });
  });

  it('api: conv=false, hint=true, resume=false, inject=false', () => {
    const config = makeConfig({ planner: { kind: 'api', provider: 'ollama', apiBase: 'http://localhost:11434/v1', model: 'qwen:7b' } });
    const planner = createApiPlanner(config);
    expect(planner.capabilities).toEqual({
      supportsConversationalPlanning: false,
      supportsHintEscalation: true,
      supportsSessionResume: false,
      supportsMidStreamInjection: false,
    });
  });

  it.each([
    'codex',
    'opencode',
    'aider',
    'copilot',
    'kilo-code',
  ] as const)('cli %s: conv=false, hint=true, resume=false, inject=false', (tool) => {
    const config = makeConfig({ planner: { kind: 'cli', tool } });
    const planner = createCliPlanner(config);
    expect(planner.capabilities).toEqual({
      supportsConversationalPlanning: false,
      supportsHintEscalation: true,
      supportsSessionResume: false,
      supportsMidStreamInjection: false,
    });
  });

  it('shell (default): all false', () => {
    const config = makeConfig({ planner: { kind: 'shell', command: 'echo' } });
    const planner = createShellPlanner(config);
    expect(planner.capabilities).toEqual({
      supportsConversationalPlanning: false,
      supportsHintEscalation: false,
      supportsSessionResume: false,
      supportsMidStreamInjection: false,
    });
  });

  it('agent (default): all false', () => {
    const config = makeConfig({ planner: { kind: 'agent', command: 'echo' } });
    const planner = createAgentPlanner(config);
    expect(planner.capabilities).toEqual({
      supportsConversationalPlanning: false,
      supportsHintEscalation: false,
      supportsSessionResume: false,
      supportsMidStreamInjection: false,
    });
  });
});

describe('shell/agent capabilities config override (FR-004)', () => {
  it('shell: individual fields can be overridden via config', () => {
    const config = makeConfig({
      planner: {
        kind: 'shell',
        command: 'claude-zai',
        capabilities: { supportsConversationalPlanning: true, supportsSessionResume: true },
      },
    });
    const planner = createShellPlanner(config);
    expect(planner.capabilities).toEqual({
      supportsConversationalPlanning: true,
      supportsHintEscalation: false,
      supportsSessionResume: true,
      supportsMidStreamInjection: false,
    });
  });

  it('agent: individual fields can be overridden via config', () => {
    const config = makeConfig({
      planner: {
        kind: 'agent',
        command: 'my-agent',
        capabilities: { supportsHintEscalation: true },
      },
    });
    const planner = createAgentPlanner(config);
    expect(planner.capabilities).toEqual({
      supportsConversationalPlanning: false,
      supportsHintEscalation: true,
      supportsSessionResume: false,
      supportsMidStreamInjection: false,
    });
  });
});

describe('capabilities config override rejected for cli/api/agent-sdk (FR-005)', () => {
  it('cli kind rejects capabilities field', () => {
    const result = PlannerConfigSchema.safeParse({
      kind: 'cli',
      tool: 'codex',
      capabilities: { supportsHintEscalation: true },
    });
    expect(result.success).toBe(false);
  });

  it('api kind rejects capabilities field', () => {
    const result = PlannerConfigSchema.safeParse({
      kind: 'api',
      apiBase: 'http://localhost:11434/v1',
      model: 'qwen:7b',
      capabilities: { supportsHintEscalation: true },
    });
    expect(result.success).toBe(false);
  });

  it('agent-sdk kind rejects capabilities field', () => {
    const result = PlannerConfigSchema.safeParse({
      kind: 'agent-sdk',
      capabilities: { supportsConversationalPlanning: false },
    });
    expect(result.success).toBe(false);
  });
});
