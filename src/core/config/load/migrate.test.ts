import { describe, it, expect } from 'vitest';
import { migrateConfig } from './migrate.js';
import type { CliPlannerConfig, ApiPlannerConfig, AgentSdkPlannerConfig } from '../../schemas/planner-config.js';
import type { ApiImplementerConfig, ShellImplementerConfig, AgentImplementerConfig } from '../../schemas/implementer-config.js';

describe('migrateConfig', () => {
  describe('version detection', () => {
    it('passes through v2 configs unchanged', () => {
      const v2Config = {
        version: 2,
        planner: { kind: 'cli', tool: 'claude-code' },
        implementer: {
          kind: 'api',
          provider: 'ollama',
          apiBase: 'http://localhost:11434/v1',
          model: 'qwen2.5:7b',
        },
      };
      expect(migrateConfig(v2Config)).toEqual(v2Config);
    });

    it('throws on unsupported version', () => {
      expect(() =>
        migrateConfig({
          version: 99,
          planner: { kind: 'cli', tool: 'claude-code' },
          implementer: { kind: 'api', provider: 'ollama', apiBase: 'http://localhost:11434/v1' },
        })
      ).toThrow(/Unsupported config version/);
    });

    it('treats missing version as v1 and migrates', () => {
      const noVersion = {
        planner: { kind: 'claude-code' },
        implementer: { kind: 'api', tool: 'ollama', model: 'qwen' },
      };
      const result = migrateConfig(noVersion) as Record<string, unknown>;
      expect(result.version).toBe(2);
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
      expect(result.version).toBe(2);
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
      const result = migrateConfig({ planner: null, implementer: { kind: 'api' } }) as Record<string, unknown>;
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

  describe('field preservation', () => {
    it('preserves common fields (model, customModels, contextLength, temperature, timeout)', () => {
      const v1 = {
        planner: { kind: 'claude-code', model: 'opus', temperature: 0.5, timeout: 60000 },
        implementer: {
          kind: 'api',
          tool: 'ollama',
          apiBase: 'http://localhost:11434/v1',
          model: 'qwen',
          contextLength: 8192,
          customModels: ['custom1'],
        },
      };
      const result = migrateConfig(v1) as Record<string, unknown>;
      const planner = result.planner as Record<string, unknown>;
      const impl = result.implementer as Record<string, unknown>;
      expect(planner.model).toBe('opus');
      expect(planner.temperature).toBe(0.5);
      expect(planner.timeout).toBe(60000);
      expect(impl.model).toBe('qwen');
      expect(impl.contextLength).toBe(8192);
      expect(impl.customModels).toEqual(['custom1']);
    });

    it('preserves args and outputFormat for CLI planner', () => {
      const v1 = {
        planner: { kind: 'claude-code', args: ['--verbose'], outputFormat: 'stream-json' },
        implementer: { kind: 'api', tool: 'ollama', apiBase: 'http://localhost:11434/v1' },
      };
      const result = migrateConfig(v1) as Record<string, unknown>;
      const planner = result.planner as CliPlannerConfig;
      expect(planner.args).toEqual(['--verbose']);
      expect(planner.outputFormat).toBe('stream-json');
    });

    it('preserves validation, workflow, theme, shikiTheme, sessions, escalation fields', () => {
      const v1 = {
        planner: { kind: 'claude-code' },
        implementer: {
          kind: 'api',
          tool: 'ollama',
          apiBase: 'http://localhost:11434/v1',
          model: 'qwen',
        },
        validation: { typecheck: false, lint: true, test: true },
        workflow: { maxRetries: 5 },
        theme: 'dark',
        shikiTheme: 'github-dark',
        sessions: { scope: 'project' },
        escalation: { enabled: true },
      };
      const result = migrateConfig(v1) as Record<string, unknown>;
      expect(result.validation).toEqual(v1.validation);
      expect(result.workflow).toEqual(v1.workflow);
      expect(result.theme).toBe('dark');
      expect(result.shikiTheme).toBe('github-dark');
      expect(result.sessions).toEqual(v1.sessions);
      expect(result.escalation).toEqual(v1.escalation);
    });

    it('preserves apiKey for api implementer', () => {
      const v1 = {
        planner: { kind: 'claude-code' },
        implementer: {
          kind: 'api',
          tool: 'openrouter',
          apiKey: 'or-xxx',
          model: 'anthropic/claude-3.5-sonnet',
        },
      };
      const result = migrateConfig(v1) as Record<string, unknown>;
      const impl = result.implementer as ApiImplementerConfig;
      expect(impl.apiKey).toBe('or-xxx');
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
});
