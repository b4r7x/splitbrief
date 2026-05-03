import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Config } from '../../core/schemas/config.js';
import type { Implementer } from '../implementers/types.js';
import type { Planner, PlannerCapabilities } from '../planners/types.js';
import { makeConfig } from '#testing/helpers/factories/config.js';

const AGENT_SDK_PACKAGE = '@anthropic-ai/claude-agent-sdk';

const RUNNER_MODULES = [
  '../planners/claude-code.js',
  '../planners/cli.js',
  '../planners/api.js',
  '../planners/shell.js',
  '../planners/agent.js',
  '../planners/agent-sdk.js',
  '../implementers/cli.js',
  '../implementers/api.js',
  '../implementers/shell.js',
  '../implementers/agent.js',
  '../implementers/agent-sdk.js',
  AGENT_SDK_PACKAGE,
];

const plannerCapabilities: PlannerCapabilities = {
  supportsConversationalPlanning: false,
  supportsHintEscalation: true,
  supportsSessionResume: false,
  supportsEffort: false,
  supportsImages: false,
  supportsSelfSummarisation: true,
};

function createMockPlanner(): Planner {
  return {
    isAvailable: async () => true,
    getVersion: async () => null,
    plan: async () => ({ spec: '', plan: '', tasks: [], usage: null }),
    regenerate: async () => ({ text: '', usage: null }),
    escalateHint: async () => ({ success: true, output: '', code: null, usage: null }),
    escalateFull: async () => ({ success: true, output: '', code: null, usage: null }),
    quickPlan: async () => ({ spec: '', plan: '', tasks: [], usage: null }),
    review: async () => ({ text: '', usage: null }),
    summarize: async () => '',
    capabilities: plannerCapabilities,
  };
}

function createMockImplementer(): Implementer {
  return {
    isAvailable: async () => true,
    getVersion: async () => null,
    implement: async () => ({ success: true, output: '' }),
    retry: async () => ({ success: true, output: '' }),
    capabilities: { writesFiles: 'extracted-code' },
  };
}

function mockRunnerModules(loaded: string[]): void {
  vi.doMock('../planners/claude-code.js', () => {
    loaded.push('planner:claude-code');
    return { createClaudeCodePlanner: () => createMockPlanner() };
  });
  vi.doMock('../planners/cli.js', () => {
    loaded.push('planner:cli');
    return { createCliPlanner: () => createMockPlanner() };
  });
  vi.doMock('../planners/api.js', () => {
    loaded.push('planner:api');
    return { createApiPlanner: () => createMockPlanner() };
  });
  vi.doMock('../planners/shell.js', () => {
    loaded.push('planner:shell');
    return { createShellPlanner: () => createMockPlanner() };
  });
  vi.doMock('../planners/agent.js', () => {
    loaded.push('planner:agent');
    return { createAgentPlanner: () => createMockPlanner() };
  });
  vi.doMock('../planners/agent-sdk.js', () => {
    loaded.push('planner:agent-sdk');
    return { createAgentSdkPlanner: () => createMockPlanner() };
  });
  vi.doMock('../implementers/cli.js', () => {
    loaded.push('implementer:cli');
    return { createCliImplementer: () => createMockImplementer() };
  });
  vi.doMock('../implementers/api.js', () => {
    loaded.push('implementer:api');
    return { createApiImplementer: () => createMockImplementer() };
  });
  vi.doMock('../implementers/shell.js', () => {
    loaded.push('implementer:shell');
    return { createShellImplementer: () => createMockImplementer() };
  });
  vi.doMock('../implementers/agent.js', () => {
    loaded.push('implementer:agent');
    return { createAgentImplementer: () => createMockImplementer() };
  });
  vi.doMock('../implementers/agent-sdk.js', () => {
    loaded.push('implementer:agent-sdk');
    return { createAgentSdkImplementer: () => createMockImplementer() };
  });
}

function mockAgentSdkPackage(): void {
  vi.doMock(AGENT_SDK_PACKAGE, () => ({ query: vi.fn() }));
}

function withPlanner(planner: Config['planner']): Config {
  return { ...makeConfig(), planner };
}

function withImplementer(implementer: Config['implementer']): Config {
  return { ...makeConfig(), implementer };
}

afterEach(() => {
  vi.resetModules();
  for (const id of RUNNER_MODULES) vi.doUnmock(id);
  vi.doUnmock('../../lib/warn.js');
});

describe('createPlanner lazy loading', () => {
  const cases: Array<{ name: string; config: Config; expectedModule: string; mockAgentSdk?: boolean }> = [
    { name: 'claude-code planner', config: withPlanner({ kind: 'cli', tool: 'claude-code' }), expectedModule: 'planner:claude-code' },
    { name: 'generic CLI planner', config: withPlanner({ kind: 'cli', tool: 'codex' }), expectedModule: 'planner:cli' },
    { name: 'API planner', config: withPlanner({ kind: 'api', provider: 'ollama', apiBase: 'http://localhost:11434/v1', model: 'test' }), expectedModule: 'planner:api' },
    { name: 'shell planner', config: withPlanner({ kind: 'shell', command: 'cat', outputFormat: 'text' }), expectedModule: 'planner:shell' },
    { name: 'agent planner', config: withPlanner({ kind: 'agent', command: 'cat', outputFormat: 'text' }), expectedModule: 'planner:agent' },
    { name: 'agent SDK planner', config: withPlanner({ kind: 'agent-sdk', model: 'test', apiKey: 'sk-test' }), expectedModule: 'planner:agent-sdk', mockAgentSdk: true },
  ];

  it.each(cases)('loads only the selected $name module', async ({ config, expectedModule, mockAgentSdk }) => {
    const loaded: string[] = [];
    mockRunnerModules(loaded);
    if (mockAgentSdk) mockAgentSdkPackage();

    const { createPlanner } = await import('./factory.js');

    expect(loaded).toEqual([]);
    const planner = await createPlanner(config);
    expect(planner.plan).toBeTypeOf('function');
    expect(loaded).toEqual([expectedModule]);

    await createPlanner(config);
    expect(loaded).toEqual([expectedModule]);
  });
});

describe('createImplementer lazy loading', () => {
  const cases: Array<{ name: string; config: Config; expectedModule: string; mockAgentSdk?: boolean }> = [
    { name: 'CLI implementer', config: withImplementer({ kind: 'cli', tool: 'codex', model: 'test' }), expectedModule: 'implementer:cli' },
    { name: 'API implementer', config: withImplementer({ kind: 'api', provider: 'ollama', apiBase: 'http://localhost:11434/v1', model: 'test' }), expectedModule: 'implementer:api' },
    { name: 'shell implementer', config: withImplementer({ kind: 'shell', command: 'cat', outputFormat: 'text', model: 'test' }), expectedModule: 'implementer:shell' },
    { name: 'agent implementer', config: withImplementer({ kind: 'agent', command: 'cat', outputFormat: 'text', model: 'test' }), expectedModule: 'implementer:agent' },
    { name: 'agent SDK implementer', config: withImplementer({ kind: 'agent-sdk', model: 'test', apiKey: 'sk-test' }), expectedModule: 'implementer:agent-sdk', mockAgentSdk: true },
  ];

  it.each(cases)('loads only the selected $name module', async ({ config, expectedModule, mockAgentSdk }) => {
    const loaded: string[] = [];
    mockRunnerModules(loaded);
    if (mockAgentSdk) mockAgentSdkPackage();

    const { createImplementer } = await import('./factory.js');

    expect(loaded).toEqual([]);
    const implementer = await createImplementer(config);
    expect(implementer.implement).toBeTypeOf('function');
    expect(loaded).toEqual([expectedModule]);

    await createImplementer(config);
    expect(loaded).toEqual([expectedModule]);
  });
});

describe('effort warning', () => {
  it('warns when planner config has effort but backend does not support it', async () => {
    const loaded: string[] = [];
    mockRunnerModules(loaded);
    const warnStderr = vi.fn();
    vi.doMock('../../lib/warn.js', () => ({ warnStderr, warnError: vi.fn() }));

    const { createPlanner } = await import('./factory.js');
    const config = withPlanner({ kind: 'api', provider: 'ollama', apiBase: 'http://localhost:11434/v1', model: 'test', effort: 'high' });
    await createPlanner(config);

    expect(warnStderr).toHaveBeenCalledOnce();
    expect(warnStderr).toHaveBeenCalledWith(expect.stringContaining('planner-effort'));
  });
});

describe('invalid runner kind', () => {
  it('throws on invalid planner kind', async () => {
    const config = { ...makeConfig(), planner: { kind: 'invalid' } as unknown as Config['planner'] };
    const { createPlanner } = await import('./factory.js');
    await expect(createPlanner(config)).rejects.toThrow(/invalid/i);
  });

  it('throws on invalid implementer kind', async () => {
    const config = { ...makeConfig(), implementer: { kind: 'invalid' } as unknown as Config['implementer'] };
    const { createImplementer } = await import('./factory.js');
    await expect(createImplementer(config)).rejects.toThrow(/invalid/i);
  });
});

describe('agent-sdk optional dependency', () => {
  it('throws a clear install instruction when the package is missing', async () => {
    const loaded: string[] = [];
    mockRunnerModules(loaded);

    const { createPlanner, createImplementer } = await import('./factory.js');

    await expect(createPlanner(withPlanner({ kind: 'agent-sdk', model: 'test', apiKey: 'sk-test' })))
      .rejects.toThrow('npm install @anthropic-ai/claude-agent-sdk');
    await expect(createImplementer(withImplementer({ kind: 'agent-sdk', model: 'test', apiKey: 'sk-test' })))
      .rejects.toThrow('npm install @anthropic-ai/claude-agent-sdk');
    expect(loaded).toEqual([]);
  });
});
