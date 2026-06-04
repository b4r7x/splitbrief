import { describe, it, expect, vi, afterEach } from 'vitest';
import { applyCLIOverrides, applyApproveOverride } from './overrides.js';
import type { Config } from '../../schemas/config.js';
import { resolveImplementerProfiles } from '../accessors/implementer-profiles.js';
import { makeConfig } from '#testing/helpers/factories/config.js';

function buildBaseConfig(): Config {
  const c = makeConfig({ workflow: { approve: 'default' } });
  delete (c.workflow as Record<string, unknown>).autoApproveSpec;
  delete (c.workflow as Record<string, unknown>).autoApprovePlan;
  return c;
}
const baseConfig: Config = buildBaseConfig();

describe('applyCLIOverrides — approve / auto', () => {
  it('--approve <level> sets workflow.approve', () => {
    const result = applyCLIOverrides(baseConfig, { approve: 'none' });
    expect(result.workflow.approve).toBe('none');
  });

  it('--approve none also dual-writes legacy autoApprove* keys', () => {
    const result = applyCLIOverrides(baseConfig, { approve: 'none' });
    expect(result.workflow.autoApproveSpec).toBe(true);
    expect(result.workflow.autoApprovePlan).toBe(true);
  });

  it('--approve all does not dual-write legacy keys', () => {
    const result = applyCLIOverrides(baseConfig, { approve: 'all' });
    expect(result.workflow.approve).toBe('all');
    expect(result.workflow.autoApproveSpec).toBeUndefined();
    expect(result.workflow.autoApprovePlan).toBeUndefined();
  });

  it('--auto sets approve=none and dual-writes autoApprove*', () => {
    const result = applyCLIOverrides(baseConfig, { autoApprove: true });
    expect(result.workflow.approve).toBe('none');
    expect(result.workflow.autoApproveSpec).toBe(true);
    expect(result.workflow.autoApprovePlan).toBe(true);
  });

  it('--auto false does not change approve', () => {
    const result = applyCLIOverrides(baseConfig, { autoApprove: false });
    expect(result.workflow.approve).toBe('default');
    expect(result.workflow.autoApproveSpec).toBe(false);
    expect(result.workflow.autoApprovePlan).toBe(false);
  });

  it('--auto wins when both --auto and --approve are provided', () => {
    const result = applyCLIOverrides(baseConfig, { approve: 'spec', autoApprove: true });
    expect(result.workflow.approve).toBe('none');
  });

  it('throws on invalid --approve value', () => {
    expect(() => applyCLIOverrides(baseConfig, { approve: 'bogus' })).toThrow(/Must be one of/);
  });

  it('accepts --approve default', () => {
    const result = applyCLIOverrides(baseConfig, { approve: 'default' });
    expect(result.workflow.approve).toBe('default');
  });
});

describe('applyApproveOverride', () => {
  it('sets approve and dual-writes when level is none', () => {
    const result = applyApproveOverride(baseConfig, 'none');
    expect(result.workflow.approve).toBe('none');
    expect(result.workflow.autoApproveSpec).toBe(true);
    expect(result.workflow.autoApprovePlan).toBe(true);
  });

  it('only sets approve for non-none levels', () => {
    const result = applyApproveOverride(baseConfig, 'plan');
    expect(result.workflow.approve).toBe('plan');
    expect(result.workflow.autoApproveSpec).toBeUndefined();
  });
});

describe('applyCLIOverrides — plannerEffort', () => {
  it('sets planner.effort when valid', () => {
    const result = applyCLIOverrides(baseConfig, { plannerEffort: 'high' });
    expect(result.planner.effort).toBe('high');
  });
  it('throws on invalid effort value', () => {
    expect(() => applyCLIOverrides(baseConfig, { plannerEffort: 'bogus' })).toThrow(
      /Must be one of/,
    );
  });
  it('leaves config untouched when override absent', () => {
    const result = applyCLIOverrides(baseConfig, {});
    expect(result.planner.effort).toBeUndefined();
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
      implementer: { command: 'custom-implementer' },
    });

    expect(result.implementer.kind).toBe('shell');
    if (result.implementer.kind === 'shell') {
      expect(result.implementer.command).toBe('custom-implementer');
      expect(result.implementer.model).toBe(baseConfig.implementer.model);
    }
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

describe('applyCLIOverrides — yolo', () => {
  it('yolo override disables approval', () => {
    const result = applyCLIOverrides(baseConfig, { yolo: true });
    expect(result.approval?.enabled).toBe(false);
  });

  it('yolo override preserves other approval fields', () => {
    const config: Config = {
      ...baseConfig,
      approval: {
        enabled: true,
        tiers: { destructive: 'confirm' },
        feedRejectionsToPlanner: true,
      },
    };
    const result = applyCLIOverrides(config, { yolo: true });
    expect(result.approval?.enabled).toBe(false);
    expect(result.approval?.tiers?.destructive).toBe('confirm');
    expect(result.approval?.feedRejectionsToPlanner).toBe(true);
  });

  it('non-yolo override does not change approval', () => {
    const config: Config = {
      ...baseConfig,
      approval: { enabled: true, feedRejectionsToPlanner: true },
    };
    const result = applyCLIOverrides(config, {});
    expect(result.approval?.enabled).toBe(true);
  });
});
