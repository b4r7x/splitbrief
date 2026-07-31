import { describe, it, expect } from 'vitest';
import { migrateConfig, migrateV2ToV3 } from './migrate.js';
import {
  ImplementerConfigSchema,
  ImplementerProfileConfigSchema,
} from '../../schemas/implementer-config.js';
import { PlannerConfigSchema } from '../../schemas/planner-config.js';
import type {
  CliPlannerConfig,
  ApiPlannerConfig,
  AgentSdkPlannerConfig,
} from '../../schemas/planner-config.js';
import type {
  ApiImplementerConfig,
  ShellImplementerConfig,
  AgentImplementerConfig,
} from '../../schemas/implementer-config.js';

describe('migrateConfig', () => {
  describe('version detection', () => {
    it('migrates v2 configs to v3, preserving deprecated workflow keys', () => {
      const v2Config = {
        version: 2,
        planner: { kind: 'cli', tool: 'claude-code' },
        implementer: {
          kind: 'api',
          provider: 'ollama',
          apiBase: 'http://localhost:11434/v1',
          model: 'qwen2.5:7b',
        },
        workflow: {
          autoApproveSpec: false,
          autoApprovePlan: false,
          maxRetries: 3,
          commitStrategy: 'none',
        },
      };
      const warnings: string[] = [];
      const result = migrateConfig(v2Config, warnings) as Record<string, unknown>;
      expect(result.version).toBe(3);
      const workflow = result.workflow as Record<string, unknown>;
      expect(workflow.commitStrategy).toBe('none');
      expect(workflow.git).toEqual({ commitStrategy: 'none' });
      expect(workflow.approve).toBe('default');
      expect(warnings.some((w) => /version 2 is deprecated/.test(w))).toBe(true);
    });

    it('passes through current v3 configs unchanged', () => {
      const v3Config = {
        version: 3,
        planner: { kind: 'cli', tool: 'claude-code' },
        implementer: {
          kind: 'api',
          provider: 'ollama',
          service: 'ollama',
          offering: 'local',
          apiBase: 'http://localhost:11434/v1',
          model: 'qwen2.5:7b',
        },
      };
      expect(migrateConfig(v3Config)).toEqual(v3Config);
    });

    it.each([
      2, 3,
    ])('normalizes provider-only API identities in every runner slot after v%s migration', (version) => {
      const migrated = migrateConfig({
        version,
        planner: {
          kind: 'api',
          provider: 'anthropic',
          apiBase: 'https://api.anthropic.com/v1',
          model: 'claude-opus-4',
        },
        implementer: {
          kind: 'api',
          provider: 'ollama',
          apiBase: 'http://localhost:11434/v1',
          model: 'qwen2.5:7b',
        },
        implementerProfiles: {
          default: 'cloud',
          profiles: {
            cloud: {
              kind: 'api',
              provider: 'openrouter',
              apiBase: 'https://openrouter.ai/api/v1',
              model: 'anthropic/claude-sonnet-4',
            },
            local: {
              kind: 'api',
              provider: 'lm-studio',
              apiBase: 'http://localhost:1234/v1',
              model: 'local-model',
            },
          },
        },
      }) as Record<string, unknown>;

      expect(migrated).toMatchObject({
        planner: { service: 'anthropic', offering: 'payg' },
        implementer: { service: 'ollama', offering: 'local' },
        implementerProfiles: {
          profiles: {
            cloud: { service: 'openrouter', offering: 'payg' },
            local: { service: 'lm-studio', offering: 'local' },
          },
        },
      });
      PlannerConfigSchema.parse(migrated.planner);
      ImplementerConfigSchema.parse(migrated.implementer);
      const implementerProfiles = migrated.implementerProfiles as Record<string, unknown>;
      const profiles = implementerProfiles.profiles as Record<string, unknown>;
      ImplementerProfileConfigSchema.parse(profiles.cloud);
      ImplementerProfileConfigSchema.parse(profiles.local);
    });

    it.each([
      2, 3,
    ])('rejects a non-catalog provider-only API runner after v%s migration', (version) => {
      const migrated = migrateConfig({
        version,
        planner: { kind: 'cli', tool: 'claude-code' },
        implementer: {
          kind: 'api',
          provider: 'custom-provider',
          apiBase: 'https://llm.example.test/v1',
          model: 'custom-model',
        },
      }) as Record<string, unknown>;

      expect(ImplementerConfigSchema.safeParse(migrated.implementer).success).toBe(false);
    });

    it('preserves partial and mismatched API identities for strict schema rejection', () => {
      const migrated = migrateConfig({
        version: 3,
        planner: {
          kind: 'api',
          provider: 'openrouter',
          service: 'openrouter',
          apiBase: 'https://openrouter.ai/api/v1',
        },
        implementer: {
          kind: 'api',
          provider: 'ollama',
          service: 'ollama',
          offering: 'payg',
          apiBase: 'http://localhost:11434/v1',
          model: 'qwen2.5:7b',
        },
      }) as Record<string, unknown>;

      expect(migrated.planner).toMatchObject({ service: 'openrouter' });
      expect(migrated.planner).not.toHaveProperty('offering');
      expect(migrated.implementer).toMatchObject({ service: 'ollama', offering: 'payg' });
      expect(PlannerConfigSchema.safeParse(migrated.planner).success).toBe(false);
      expect(ImplementerConfigSchema.safeParse(migrated.implementer).success).toBe(false);
    });

    it('folds a legacy top-level commitStrategy into git on a v3 config', () => {
      const v3Config = {
        version: 3,
        planner: { kind: 'cli', tool: 'claude-code' },
        implementer: { kind: 'api', provider: 'ollama', apiBase: 'http://localhost:11434/v1' },
        workflow: { commitStrategy: 'per-task', maxRetries: 3 },
      };
      const result = migrateConfig(v3Config) as Record<string, unknown>;
      const workflow = result.workflow as Record<string, unknown>;
      expect(workflow.git).toEqual({ commitStrategy: 'per-task' });
    });

    it('keeps an explicit v3 git.commitStrategy over the legacy field', () => {
      const v3Config = {
        version: 3,
        planner: { kind: 'cli', tool: 'claude-code' },
        implementer: { kind: 'api', provider: 'ollama', apiBase: 'http://localhost:11434/v1' },
        workflow: { commitStrategy: 'per-task', git: { commitStrategy: 'checkpoint' } },
      };
      const result = migrateConfig(v3Config) as Record<string, unknown>;
      const workflow = result.workflow as Record<string, unknown>;
      expect(workflow.git).toEqual({ commitStrategy: 'checkpoint' });
    });

    it('throws on unsupported version', () => {
      expect(() =>
        migrateConfig({
          version: 99,
          planner: { kind: 'cli', tool: 'claude-code' },
          implementer: { kind: 'api', provider: 'ollama', apiBase: 'http://localhost:11434/v1' },
        }),
      ).toThrow(/Unsupported config version/);
    });

    it('migrates a missing-version config to v3 while warning about the lossy v1 path', () => {
      const noVersion = {
        planner: { kind: 'claude-code' },
        implementer: { kind: 'api', tool: 'ollama', model: 'qwen' },
      };
      const warnings: string[] = [];
      const result = migrateConfig(noVersion, warnings) as Record<string, unknown>;
      expect(result.version).toBe(3);
      expect(warnings.some((w) => /config\.version is missing/.test(w))).toBe(true);
    });

    it('warns when the missing-version v1 path drops post-v1 effort and capabilities', () => {
      const noVersion = {
        planner: {
          kind: 'shell',
          command: 'my-planner',
          model: 'x',
          effort: 'high',
          capabilities: { supportsSessionResume: true },
        },
        implementer: { kind: 'api', tool: 'ollama', model: 'qwen', effort: 'low' },
      };
      const warnings: string[] = [];
      const result = migrateConfig(noVersion, warnings) as Record<string, unknown>;
      const planner = result.planner as Record<string, unknown>;
      const implementer = result.implementer as Record<string, unknown>;
      expect(planner.effort).toBeUndefined();
      expect(planner.capabilities).toBeUndefined();
      expect(implementer.effort).toBeUndefined();
      expect(warnings.some((w) => /config\.version is missing/.test(w))).toBe(true);
    });

    it('does not warn about a missing version when version is explicit', () => {
      const v3Config = {
        version: 3,
        planner: { kind: 'cli', tool: 'claude-code' },
        implementer: { kind: 'api', provider: 'ollama', apiBase: 'http://localhost:11434/v1' },
      };
      const warnings: string[] = [];
      migrateConfig(v3Config, warnings);
      expect(warnings.some((w) => /config\.version is missing/.test(w))).toBe(false);
    });

    it('throws if config is not an object', () => {
      expect(() => migrateConfig(null)).toThrow('Config must be an object');
      expect(() => migrateConfig('string')).toThrow('Config must be an object');
    });
  });

  describe('planner migration', () => {
    it('migrates legacy kind: "claude-code" → kind: "cli", tool: "claude-code"', () => {
      const v1 = {
        planner: { kind: 'claude-code', model: 'opus' },
        implementer: {
          kind: 'api',
          tool: 'ollama',
          apiBase: 'http://localhost:11434/v1',
          model: 'qwen',
        },
      };
      const result = migrateConfig(v1) as Record<string, unknown>;
      const planner = result.planner as CliPlannerConfig;
      expect(result.version).toBe(3);
      expect(planner.kind).toBe('cli');
      expect(planner.tool).toBe('claude-code');
      expect(planner.model).toBe('opus');
    });

    it('migrates other CLI tool kinds (codex, opencode, aider)', () => {
      for (const tool of ['codex', 'opencode', 'aider']) {
        const v1 = {
          planner: { kind: tool },
          implementer: { kind: 'api', tool: 'ollama', apiBase: 'http://localhost:11434/v1' },
        };
        const result = migrateConfig(v1) as Record<string, unknown>;
        const planner = result.planner as CliPlannerConfig;
        expect(planner.kind).toBe('cli');
        expect(planner.tool).toBe(tool);
      }
    });

    it('migrates agent-sdk planner', () => {
      const v1 = {
        planner: { kind: 'agent-sdk', apiKey: 'sk-xxx' },
        implementer: {
          kind: 'api',
          tool: 'ollama',
          apiBase: 'http://localhost:11434/v1',
          model: 'qwen',
        },
      };
      const result = migrateConfig(v1) as Record<string, unknown>;
      const planner = result.planner as AgentSdkPlannerConfig;
      expect(planner.kind).toBe('agent-sdk');
      expect(planner.apiKey).toBe('sk-xxx');
    });

    it('migrates api planner with provider resolution', () => {
      const v1 = {
        planner: { kind: 'api', tool: 'anthropic', model: 'claude-3-5-sonnet-20241022' },
        implementer: { kind: 'api', tool: 'ollama', apiBase: 'http://localhost:11434/v1' },
      };
      const result = migrateConfig(v1) as Record<string, unknown>;
      const planner = result.planner as ApiPlannerConfig;
      expect(planner.kind).toBe('api');
      expect(planner.provider).toBe('anthropic');
      expect(planner.apiBase).toBe('https://api.anthropic.com/v1');
    });

    it('returns undefined for planner when null', () => {
      const result = migrateConfig({ planner: null, implementer: { kind: 'api' } }) as Record<
        string,
        unknown
      >;
      expect(result.planner).toBeUndefined();
    });
  });

  describe('implementer migration', () => {
    it('migrates legacy kind: "api", tool: "ollama" → kind: "api", provider: "ollama"', () => {
      const v1 = {
        planner: { kind: 'claude-code' },
        implementer: { kind: 'api', tool: 'ollama', model: 'llama3' },
      };
      const result = migrateConfig(v1) as Record<string, unknown>;
      const impl = result.implementer as ApiImplementerConfig;
      expect(impl.kind).toBe('api');
      expect(impl.provider).toBe('ollama');
      expect(impl.apiBase).toBe('http://localhost:11434/v1');
      expect(impl.model).toBe('llama3');
    });

    it('migrates lm-studio implementer with default apiBase', () => {
      const v1 = {
        planner: { kind: 'claude-code' },
        implementer: { kind: 'api', tool: 'lm-studio', model: 'local-model' },
      };
      const result = migrateConfig(v1) as Record<string, unknown>;
      const impl = result.implementer as ApiImplementerConfig;
      expect(impl.provider).toBe('lm-studio');
      expect(impl.apiBase).toBe('http://localhost:1234/v1');
    });

    it('migrates shell implementer', () => {
      const v1 = {
        planner: { kind: 'claude-code' },
        implementer: { kind: 'shell', command: 'my-llm', args: ['--json'] },
      };
      const result = migrateConfig(v1) as Record<string, unknown>;
      const impl = result.implementer as ShellImplementerConfig;
      expect(impl.kind).toBe('shell');
      expect(impl.command).toBe('my-llm');
      expect(impl.args).toEqual(['--json']);
    });

    it('migrates agent implementer', () => {
      const v1 = {
        planner: { kind: 'claude-code' },
        implementer: { kind: 'agent', command: 'my-agent', args: ['-v'] },
      };
      const result = migrateConfig(v1) as Record<string, unknown>;
      const impl = result.implementer as AgentImplementerConfig;
      expect(impl.kind).toBe('agent');
      expect(impl.command).toBe('my-agent');
      expect(impl.args).toEqual(['-v']);
    });

    it('throws for shell implementer without command', () => {
      const v1 = {
        planner: { kind: 'claude-code' },
        implementer: { kind: 'shell' },
      };
      expect(() => migrateConfig(v1)).toThrow("implementer shell kind requires 'command' field");
    });

    it('throws for unknown provider without apiBase', () => {
      const v1 = {
        planner: { kind: 'claude-code' },
        implementer: { kind: 'api', tool: 'unknown-provider', model: 'x' },
      };
      expect(() => migrateConfig(v1)).toThrow(/requires explicit apiBase/);
    });

    it('preserves explicit apiBase for unknown provider', () => {
      const v1 = {
        planner: { kind: 'claude-code' },
        implementer: {
          kind: 'api',
          tool: 'custom-provider',
          apiBase: 'https://custom.api/v1',
          model: 'custom-model',
        },
      };
      const result = migrateConfig(v1) as Record<string, unknown>;
      const impl = result.implementer as ApiImplementerConfig;
      expect(impl.kind).toBe('api');
      expect(impl.provider).toBe('custom-provider');
      expect(impl.apiBase).toBe('https://custom.api/v1');
    });
  });

  describe('kind inference from shape', () => {
    it('infers cli kind from tool field with known CLI tool', () => {
      const v1 = {
        planner: { tool: 'claude-code' },
        implementer: { kind: 'api', tool: 'ollama', apiBase: 'http://localhost:11434/v1' },
      };
      const result = migrateConfig(v1) as Record<string, unknown>;
      const planner = result.planner as CliPlannerConfig;
      expect(planner.kind).toBe('cli');
      expect(planner.tool).toBe('claude-code');
    });

    it('infers api kind from apiBase field', () => {
      const v1 = {
        planner: { kind: 'claude-code' },
        implementer: { apiBase: 'http://localhost:11434/v1', model: 'llama3' },
      };
      const result = migrateConfig(v1) as Record<string, unknown>;
      const impl = result.implementer as Record<string, unknown>;
      expect(impl.kind).toBe('api');
    });

    it('infers shell kind from command field', () => {
      const v1 = {
        planner: { kind: 'claude-code' },
        implementer: { command: 'my-local-llm', args: ['--format', 'json'] },
      };
      const result = migrateConfig(v1) as Record<string, unknown>;
      const impl = result.implementer as ShellImplementerConfig;
      expect(impl.kind).toBe('shell');
      expect(impl.command).toBe('my-local-llm');
    });

    it('defaults implementer to api kind with ollama provider when no hints', () => {
      const v1 = {
        planner: { kind: 'claude-code' },
        implementer: { model: 'qwen2.5:7b' },
      };
      const result = migrateConfig(v1) as Record<string, unknown>;
      const impl = result.implementer as ApiImplementerConfig;
      expect(impl.kind).toBe('api');
      expect(impl.provider).toBe('ollama');
      expect(impl.apiBase).toBe('http://localhost:11434/v1');
    });

    it('defaults planner to cli kind with claude-code when no hints', () => {
      const v1 = {
        planner: { model: 'claude-opus-4' },
        implementer: { kind: 'api', tool: 'ollama', apiBase: 'http://localhost:11434/v1' },
      };
      const result = migrateConfig(v1) as Record<string, unknown>;
      const planner = result.planner as CliPlannerConfig;
      expect(planner.kind).toBe('cli');
      expect(planner.tool).toBe('claude-code');
      expect(planner.model).toBe('claude-opus-4');
    });
  });

  describe('top-level passthrough keys', () => {
    it('retains the trust block when migrating a v1 config', () => {
      const v1 = {
        planner: { kind: 'claude-code' },
        implementer: { kind: 'api', tool: 'ollama', apiBase: 'http://localhost:11434/v1' },
        trust: { customRenderers: true },
      };
      const result = migrateConfig(v1) as Record<string, unknown>;
      expect(result.trust).toEqual({ customRenderers: true });
    });
  });
});

describe('migrateV2ToV3', () => {
  it('bumps version to 3', () => {
    const v3 = migrateV2ToV3({ version: 2 });
    expect(v3.version).toBe(3);
  });

  it('moves top-level workflow.commitStrategy into workflow.git', () => {
    const v3 = migrateV2ToV3({
      version: 2,
      workflow: { commitStrategy: 'per-task', maxRetries: 3 },
    });
    const workflow = v3.workflow as Record<string, unknown>;
    expect(workflow.commitStrategy).toBe('per-task');
    expect(workflow.git).toEqual({ commitStrategy: 'per-task' });
  });

  it('preserves an existing workflow.git block over the top-level field', () => {
    const v3 = migrateV2ToV3({
      version: 2,
      workflow: { commitStrategy: 'per-task', git: { commitStrategy: 'final' } },
    });
    const workflow = v3.workflow as Record<string, unknown>;
    expect(workflow.git).toEqual({ commitStrategy: 'final' });
  });

  it('derives workflow.approve from auto-approve flags', () => {
    const both = migrateV2ToV3({ workflow: { autoApproveSpec: true, autoApprovePlan: true } });
    expect((both.workflow as Record<string, unknown>).approve).toBe('none');

    const specOnly = migrateV2ToV3({ workflow: { autoApproveSpec: true } });
    expect((specOnly.workflow as Record<string, unknown>).approve).toBe('plan');

    const planOnly = migrateV2ToV3({ workflow: { autoApprovePlan: true } });
    expect((planOnly.workflow as Record<string, unknown>).approve).toBe('spec');
  });

  it('rewrites legacy workflow.mode "full" to "speckit"', () => {
    const v3 = migrateV2ToV3({ workflow: { mode: 'full' } });
    const workflow = v3.workflow as Record<string, unknown>;
    expect(workflow.mode).toBe('speckit');
  });

  it('does not invent a workflow block when none was present', () => {
    const v3 = migrateV2ToV3({ version: 2 });
    expect(v3.workflow).toBeUndefined();
  });
});
