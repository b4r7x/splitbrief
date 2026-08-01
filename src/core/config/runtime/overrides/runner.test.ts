import { describe, it, expect, vi, afterEach } from 'vitest';
import { applyCLIOverrides } from './apply.js';
import { buildRunnerConfig } from '../build-runner.js';
import { existingToOpts } from './runner.js';
import type { Config } from '../../../schemas/config.js';
import type { PlannerConfig } from '../../../schemas/planner-config.js';
import type { ImplementerConfig } from '../../../schemas/implementer-config.js';
import { resolveImplementerProfiles } from '../../accessors/implementer-profiles.js';
import { makeConfig } from '#testing/helpers/factories/config.js';

const baseConfig: Config = makeConfig({ workflow: { approve: 'default' } });

const commonGeneration = {
  customModels: ['model-primary', 'model-fallback'],
  contextLength: 131_072,
  temperature: 0.4,
  timeout: 240_000,
  effort: 'high' as const,
};

const plannerCapabilities = {
  supportsConversationalPlanning: true,
  supportsHintEscalation: true,
  supportsSessionResume: false,
  supportsEffort: false,
  supportsImages: false,
  supportsSelfSummarisation: true,
};

const watchdogs = { idleWarnMs: 90_000, idleKillMs: 600_000 };

const sameTargetCases: readonly (
  | { role: 'planner'; existing: PlannerConfig }
  | { role: 'implementer'; existing: ImplementerConfig }
)[] = [
  {
    role: 'planner',
    existing: {
      kind: 'cli',
      tool: 'claude-code',
      authChannel: 'session',
      model: 'claude-opus-4-6',
      args: ['--permission-mode', 'plan'],
      outputFormat: 'stream-json',
      ...watchdogs,
      ...commonGeneration,
    },
  },
  {
    role: 'planner',
    existing: {
      kind: 'api',
      provider: 'openrouter',
      service: 'openrouter',
      offering: 'payg',
      apiBase: 'https://openrouter.ai/api/v1',
      apiKey: 'env:OPENROUTER_API_KEY',
      model: 'anthropic/claude-opus-4.6',
      ...commonGeneration,
    },
  },
  {
    role: 'planner',
    existing: {
      kind: 'shell',
      command: 'planner-shell',
      args: ['--json'],
      outputFormat: 'jsonl',
      capabilities: plannerCapabilities,
      model: 'shell-planner-model',
      ...watchdogs,
      ...commonGeneration,
    },
  },
  {
    role: 'planner',
    existing: {
      kind: 'agent',
      command: 'planner-agent',
      args: ['--verbose'],
      outputFormat: 'text',
      capabilities: plannerCapabilities,
      model: 'agent-planner-model',
      ...watchdogs,
      ...commonGeneration,
    },
  },
  {
    role: 'planner',
    existing: {
      kind: 'agent-sdk',
      apiKey: 'env:ANTHROPIC_API_KEY',
      model: 'claude-opus-4-6',
      ...watchdogs,
      ...commonGeneration,
    },
  },
  {
    role: 'implementer',
    existing: {
      kind: 'cli',
      tool: 'codex',
      authChannel: 'api-key',
      args: ['--sandbox', 'workspace-write'],
      outputFormat: 'jsonl',
      ...watchdogs,
      ...commonGeneration,
    },
  },
  {
    role: 'implementer',
    existing: {
      kind: 'api',
      provider: 'openrouter',
      service: 'openrouter',
      offering: 'payg',
      apiBase: 'https://openrouter.ai/api/v1',
      apiKey: 'env:OPENROUTER_API_KEY',
      model: 'qwen/qwen3-coder',
      ...commonGeneration,
    },
  },
  {
    role: 'implementer',
    existing: {
      kind: 'shell',
      command: 'implementer-shell',
      args: ['--apply'],
      outputFormat: 'text',
      model: 'shell-implementer-model',
      ...watchdogs,
      ...commonGeneration,
    },
  },
  {
    role: 'implementer',
    existing: {
      kind: 'agent',
      command: 'implementer-agent',
      args: ['--apply'],
      outputFormat: 'jsonl',
      model: 'agent-implementer-model',
      ...watchdogs,
      ...commonGeneration,
    },
  },
  {
    role: 'implementer',
    existing: {
      kind: 'agent-sdk',
      apiKey: 'env:ANTHROPIC_API_KEY',
      model: 'claude-sonnet-4-6',
      ...watchdogs,
      ...commonGeneration,
    },
  },
];

describe('same target runner rebuilds', () => {
  it.each(sameTargetCases)('preserves the complete $role $existing.kind config', (testCase) => {
    const opts = { ...existingToOpts(testCase.existing), existing: testCase.existing };
    const rebuilt =
      testCase.role === 'planner'
        ? buildRunnerConfig('planner', opts)
        : buildRunnerConfig('implementer', opts);

    expect(rebuilt).toEqual(testCase.existing);
  });

  it.each(
    sameTargetCases,
  )('changes only the model for a complete $role $existing.kind config', (testCase) => {
    const model = 'same-target-model-override';
    const rebuilt =
      testCase.role === 'planner'
        ? applyCLIOverrides(makeConfig({ planner: testCase.existing }), {
            planner: { model },
          }).planner
        : applyCLIOverrides(makeConfig({ implementer: testCase.existing }), {
            implementer: { model },
          }).implementer;

    expect(rebuilt).toEqual({ ...testCase.existing, model });
  });
});

describe('applyCLIOverrides — unusable provider overrides', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('warns when --implementer-api-key-env is supplied for a CLI runner', () => {
    const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    applyCLIOverrides(baseConfig, {
      implementer: {
        tool: 'claude-code',
        model: 'claude-sonnet-4-5',
        apiKey: 'env:FOO',
      },
    });
    const output = stderr.mock.calls.map((c) => String(c[0])).join('');
    expect(output).toMatch(/--implementer-api-key-env is ignored/);
  });

  it('warns when --planner-api-base is supplied for a CLI runner', () => {
    const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    applyCLIOverrides(baseConfig, {
      planner: {
        tool: 'claude-code',
        apiBase: 'https://example.com/v1',
      },
    });
    const output = stderr.mock.calls.map((c) => String(c[0])).join('');
    expect(output).toMatch(/--planner-api-base is ignored/);
  });

  it('does not warn when api-key-env is supplied for an API runner', () => {
    const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    applyCLIOverrides(baseConfig, {
      implementer: {
        tool: 'openrouter',
        model: 'qwen/qwen3-coder',
        apiBase: 'https://openrouter.ai/api/v1',
        apiKey: 'env:OPENROUTER_API_KEY',
      },
    });
    const output = stderr.mock.calls.map((c) => String(c[0])).join('');
    expect(output).not.toMatch(/is ignored/);
  });
});

describe('applyCLIOverrides — runner commands', () => {
  it('uses shell config for planner command override without explicit tool', () => {
    const result = applyCLIOverrides(baseConfig, {
      planner: { command: 'custom-planner' },
    });

    expect(result.planner.kind).toBe('shell');
    if (result.planner.kind === 'shell') {
      expect(result.planner.command).toBe('custom-planner');
    }
  });

  it('uses shell config for implementer command override without explicit tool', () => {
    const result = applyCLIOverrides(baseConfig, {
      implementer: { command: 'custom-implementer', model: 'custom-model' },
    });

    expect(result.implementer.kind).toBe('shell');
    if (result.implementer.kind === 'shell') {
      expect(result.implementer.command).toBe('custom-implementer');
      expect(result.implementer.model).toBe('custom-model');
    }
  });

  it('carries auto to a different target while resetting source state', () => {
    const config = makeConfig({
      implementer: {
        kind: 'api',
        provider: 'openrouter',
        service: 'openrouter',
        offering: 'payg',
        apiBase: 'https://openrouter.ai/api/v1',
        apiKey: 'env:OPENROUTER_API_KEY',
        model: 'anthropic/claude-opus-4.6',
        customModels: ['anthropic/claude-opus-4.6', 'source-only-model'],
        effort: 'high',
      },
    });

    const automatic = applyCLIOverrides(config, {
      implementer: { tool: 'copilot', model: 'auto' },
    });

    expect(automatic.implementer).toEqual({ kind: 'cli', tool: 'copilot', model: 'auto' });

    const result = applyCLIOverrides(config, { implementer: { tool: 'copilot' } });

    expect(result.implementer).toEqual({ kind: 'cli', tool: 'copilot' });
  });

  it('keeps every other field when --model auto lands on the current target', () => {
    const config = makeConfig({
      implementer: {
        kind: 'cli',
        tool: 'codex',
        model: 'gpt-5.4',
        customModels: ['gpt-5.4', 'gpt-5-codex'],
        effort: 'high',
        contextLength: 250_000,
        outputFormat: 'jsonl',
      },
    });

    const result = applyCLIOverrides(config, { implementer: { model: 'auto' } });

    expect(result.implementer).toEqual({
      ...config.implementer,
      model: 'auto',
    });
  });

  it('applies API base and env API key overrides to API implementers', () => {
    const result = applyCLIOverrides(baseConfig, {
      implementer: {
        tool: 'openrouter',
        model: 'qwen/qwen3-coder',
        apiBase: 'https://openrouter.ai/api/v1',
        apiKey: 'env:OPENROUTER_API_KEY',
        contextLength: 131_072,
      },
    });

    expect(result.implementer).toMatchObject({
      kind: 'api',
      provider: 'openrouter',
      model: 'qwen/qwen3-coder',
      apiBase: 'https://openrouter.ai/api/v1',
      apiKey: 'env:OPENROUTER_API_KEY',
      contextLength: 131_072,
    });
  });

  it('applies args and output format overrides to CLI implementers', () => {
    const result = applyCLIOverrides(baseConfig, {
      implementer: {
        tool: 'opencode',
        model: 'opencode/test-cheap-model',
        args: ['--reasoning', 'medium'],
        outputFormat: 'opencode',
      },
    });

    expect(result.implementer).toMatchObject({
      kind: 'cli',
      tool: 'opencode',
      model: 'opencode/test-cheap-model',
      args: ['--reasoning', 'medium'],
      outputFormat: 'opencode',
    });
  });

  it('updates the default implementer profile when profiles are configured', () => {
    const config = makeConfig({
      implementerProfiles: {
        default: 'local-qwen',
        profiles: {
          'cloud-cheap': {
            kind: 'api',
            provider: 'openrouter',
            apiBase: 'https://openrouter.ai/api/v1',
            apiKey: 'env:OPENROUTER_API_KEY',
            model: 'qwen/qwen3-coder',
            costTier: 'cheap',
          },
          'local-qwen': {
            kind: 'api',
            provider: 'ollama',
            apiBase: 'http://localhost:11434/v1',
            model: 'qwen2.5-coder:7b',
            label: 'Local Qwen',
            costTier: 'local',
          },
        },
      },
    });

    const result = applyCLIOverrides(config, {
      implementer: {
        tool: 'opencode',
        model: 'opencode/test-cheap-model',
        args: ['--reasoning', 'medium'],
        outputFormat: 'opencode',
        contextLength: 131_072,
      },
    });
    const resolved = resolveImplementerProfiles(result);

    expect(resolved.defaultProfile).toMatchObject({
      name: 'local-qwen',
      label: 'Local Qwen',
      costTier: 'local',
      capabilities: { writesFiles: 'direct' },
      config: {
        kind: 'cli',
        tool: 'opencode',
        model: 'opencode/test-cheap-model',
        args: ['--reasoning', 'medium'],
        outputFormat: 'opencode',
        contextLength: 131_072,
      },
    });
    expect(
      resolved.profiles.find((profile) => profile.name === 'cloud-cheap')?.config,
    ).toMatchObject({
      kind: 'api',
      provider: 'openrouter',
    });
  });

  it('applies planner runner fields without changing implementer config', () => {
    const result = applyCLIOverrides(baseConfig, {
      planner: {
        tool: 'anthropic',
        model: 'claude-sonnet-4-5',
        apiBase: 'https://api.anthropic.com/v1',
        apiKey: 'env:ANTHROPIC_API_KEY',
        contextLength: 200_000,
      },
    });

    expect(result.planner).toMatchObject({
      kind: 'api',
      provider: 'anthropic',
      model: 'claude-sonnet-4-5',
      apiBase: 'https://api.anthropic.com/v1',
      apiKey: 'env:ANTHROPIC_API_KEY',
      contextLength: 200_000,
    });
    expect(result.implementer).toEqual(baseConfig.implementer);
  });
});
